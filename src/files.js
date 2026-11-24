import { createReadStream } from 'node:fs';
import { link, open, stat, unlink } from 'node:fs/promises';
import { extname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export async function uploadFile(bridge, path) {
  const mime = {
    '.png': 'image/png',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
  }[extname(path).toLowerCase()];
  const file = await stat(path);
  if (!mime || !file.isFile() || file.size < 1 || file.size >= 30 * 1024 * 1024)
    throw new Error('Choose a PNG, JPEG or WebP image smaller than 30 MiB.');
  const ready = await bridge.call('prepare_upload', { content_type: mime, size: file.size });
  const url = new URL(ready.upload_url);
  if (
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && url.origin === bridge.session.endpoint.origin)) ||
    url.username ||
    url.password
  )
    throw new Error('Invalid upload destination.');
  const stream = createReadStream(path);
  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': mime,
        'Content-Length': String(file.size),
        'x-oss-forbid-overwrite': 'true',
      },
      body: stream,
      duplex: 'half',
      redirect: 'error',
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error('Image upload failed (' + response.status + ').');
    await response.body?.cancel();
    return { input_ref: ready.input_ref };
  } finally {
    stream.destroy();
  }
}
// Start with one streamed GET. Small ranges keep a slow link from timing out again.
const rangeSize = 64 * 1024;
const maxRetries = 3;
const temporaryStatuses = new Set([408, 429, 500, 502, 503, 504]);
class InterruptedDownload extends Error {}

function retryable(error) {
  return error instanceof InterruptedDownload ||
    ['TimeoutError', 'AbortError'].includes(error.name) ||
    (error instanceof TypeError && ['fetch failed', 'terminated'].includes(error.message)) ||
    ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET'].includes(error.code);
}

function strongETag(value) {
  return value && /^"[^"]*"$/.test(value) ? value : null;
}

async function receiveFile(session, url, file, output) {
  let bytes = 0;
  let hash = createHash('sha256');
  const expectedTag = strongETag(file.etag);
  let etag = expectedTag;
  let ranged = false;
  let rangesSupported = true;
  let segmentSize = rangeSize;
  let failures = 0;
  while (bytes < file.size) {
    const start = bytes;
    const end = ranged ? start + Math.min(segmentSize, file.size - start) - 1 : file.size - 1;
    const headers = { 'accept-encoding': 'identity' };
    if (ranged) {
      headers.range = `bytes=${start}-${end}`;
      if (etag) headers['if-range'] = etag;
    }
    let response;
    try {
      response = await session.request(url, {
        headers,
        signal: AbortSignal.timeout(ranged ? 45000 : 180000),
      });
      const receivedTag = strongETag(response.headers.get('etag'));
      let expectedEnd;
      if (response.status === 200) {
        // A server can ignore Range or return a fresh representation for If-Range.
        if (response.headers.has('content-range')) throw new Error('Invalid full download response.');
        if (!file.sha256 && expectedTag && receivedTag && receivedTag !== expectedTag)
          throw new Error('The download changed since the result was requested.');
        if (ranged) rangesSupported = false;
        if (bytes) {
          await output.truncate(0);
          bytes = 0;
          hash = createHash('sha256');
        }
        etag = receivedTag;
        expectedEnd = file.size;
      } else if (ranged && response.status === 206) {
        if (response.headers.get('content-range') !== `bytes ${start}-${end}/${file.size}`)
          throw new Error('Invalid download Content-Range.');
        if (!file.sha256 && (!etag || receivedTag !== etag))
          throw new Error('The download changed during recovery.');
        expectedEnd = end + 1;
      } else {
        const message = 'Download failed (' + response.status + ').';
        if (temporaryStatuses.has(response.status)) throw new InterruptedDownload(message);
        throw new Error(message);
      }
      if (!response.body) throw new InterruptedDownload('Missing download body.');
      for await (const chunk of response.body) {
        if (bytes + chunk.length > expectedEnd) throw new Error('File exceeds declared size.');
        await output.writeFile(chunk);
        hash.update(chunk);
        bytes += chunk.length;
      }
      if (bytes !== expectedEnd) throw new InterruptedDownload('Incomplete download response.');
      failures = 0;
    } catch (error) {
      await response?.body?.cancel().catch(() => {});
      // An interrupted range can still have committed useful bytes. Size the
      // next request for the connection and bound retries that make no progress.
      if (response?.status === 206 && bytes > start) {
        segmentSize = Math.max(4096, Math.min(segmentSize, bytes - start));
        failures = 0;
      }
      if (!retryable(error) || ++failures > maxRetries) throw error;
      if (bytes === file.size && !file.sha256) {
        await output.truncate(0);
        bytes = 0;
        hash = createHash('sha256');
      }
      ranged = rangesSupported && Boolean(file.sha256 || etag);
      await delay(250 * 2 ** (failures - 1));
    }
  }
  const sha256 = hash.digest('hex');
  if (file.sha256 && file.sha256 !== sha256) throw new Error('File verification failed.');
  return sha256;
}

export async function downloadFile(bridge, ref, destination) {
  const file = await bridge.call('get_result', { asset_ref: ref });
  const url = new URL(file.download_url);
  if (
    url.href !== bridge.session.endpoint.href + '/assets/' + ref ||
    !Number.isSafeInteger(file.size) ||
    file.size < 1
  )
    throw new Error('Invalid file metadata.');
  const temp = destination + '.' + randomUUID() + '.part';
  // Append mode also resets subsequent writes to the new end after a full-response restart.
  const output = await open(temp, 'ax', 0o600);
  try {
    let sha256;
    try {
      sha256 = await receiveFile(bridge.session, url, file, output);
    } finally {
      await output.close();
    }
    await link(temp, destination);
    return { path: destination, size: file.size, sha256 };
  } finally {
    await unlink(temp).catch(() => {});
  }
}
