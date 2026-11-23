import { createReadStream, createWriteStream } from 'node:fs';
import { link, stat, unlink } from 'node:fs/promises';
import { extname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

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
export async function downloadFile(bridge, ref, destination) {
  const file = await bridge.call('get_result', { asset_ref: ref });
  const url = new URL(file.download_url);
  if (
    url.href !== bridge.session.endpoint.href + '/assets/' + ref ||
    !Number.isSafeInteger(file.size) ||
    file.size < 1
  )
    throw new Error('Invalid file metadata.');
  const response = await bridge.session.request(url, { signal: AbortSignal.timeout(180000) });
  if (response.status !== 200 || !response.body)
    throw new Error('Download failed (' + response.status + ').');
  const temp = destination + '.' + randomUUID() + '.part';
  let bytes = 0;
  const hash = createHash('sha256');
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({
        transform(chunk, enc, done) {
          bytes += chunk.length;
          if (bytes > file.size) {
            done(new Error('File exceeds declared size.'));
            return;
          }
          hash.update(chunk);
          done(null, chunk);
        },
      }),
      createWriteStream(temp, { flags: 'wx', mode: 0o600 }),
    );
    const sha256 = hash.digest('hex');
    if (bytes !== file.size || (file.sha256 && file.sha256 !== sha256))
      throw new Error('File verification failed.');
    await link(temp, destination);
    return { path: destination, size: bytes, sha256 };
  } finally {
    await unlink(temp).catch(() => {});
  }
}
