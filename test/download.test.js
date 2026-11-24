import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { downloadFile } from '../src/files.js';

const endpoint = new URL('https://media.example/mcp');
const ref = 'asset_example_0';
const bytes = Buffer.alloc(160 * 1024 + 37);
for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 23 + Math.floor(i / 251)) % 256;
const digest = createHash('sha256').update(bytes).digest('hex');
const prefix = 17321;

async function fixture(t, request, sha256 = digest, metadata = {}) {
  const directory = await mkdtemp(join(tmpdir(), '3dr-resume-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = join(directory, 'result.png');
  const downloadUrl = endpoint.href + '/assets/' + ref;
  const ranges = [];
  const bridge = {
    call: async (name, args) => {
      assert.equal(name, 'get_result');
      assert.deepEqual(args, { asset_ref: ref });
      return { download_url: downloadUrl, size: bytes.length, sha256, ...metadata };
    },
    session: {
      endpoint,
      async request(url, options) {
        assert.equal(String(url), downloadUrl);
        const range = new Headers(options.headers).get('range');
        ranges.push(range);
        return request(range, ranges.length);
      },
    },
  };
  return { directory, destination, ranges, download: () => downloadFile(bridge, ref, destination) };
}

function interrupted(
  chunk,
  headers = {},
  failure = new TypeError('terminated', {
    cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
  }),
) {
  let sent = false;
  const body = new ReadableStream(
    {
      pull(controller) {
        if (sent) {
          controller.error(failure);
          return;
        }
        sent = true;
        controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, { headers: { 'content-length': String(bytes.length), ...headers } });
}

function partial(range, headers = {}, interruptAfter) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(range);
  assert.ok(match, 'expected a bounded byte range, got ' + range);
  const start = Number(match[1]),
    end = Number(match[2]);
  assert.ok(start >= 0 && start <= end && end < bytes.length);
  const data = bytes.subarray(start, end + 1);
  const body = interruptAfter === undefined ? data : interrupted(data.subarray(0, interruptAfter)).body;
  return new Response(body, {
    status: 206,
    headers: {
      'content-range': `bytes ${start}-${end}/${bytes.length}`,
      'content-length': String(end - start + 1),
      ...headers,
    },
  });
}

test('a broken full response resumes at the next byte across several authenticated ranges', async (t) => {
  const file = await fixture(t, (range, attempt) =>
    attempt === 1 ? interrupted(bytes.subarray(0, prefix)) : partial(range),
  );
  const result = await file.download();
  assert.equal(file.ranges[0], null);
  assert.ok(file.ranges.length >= 3);
  let next = prefix;
  for (const range of file.ranges.slice(1)) {
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range);
    assert.equal(Number(start), next);
    next = Number(end) + 1;
  }
  assert.equal(next, bytes.length);
  assert.deepEqual(result, { path: file.destination, size: bytes.length, sha256: digest });
  assert.deepEqual(await readFile(file.destination), bytes);
  assert.deepEqual(await readdir(file.directory), ['result.png']);
});

test('an ignored range that returns a full 200 response restarts the file at zero', async (t) => {
  const file = await fixture(t, (_range, attempt) =>
    attempt === 1 ? interrupted(bytes.subarray(0, prefix)) : new Response(bytes),
  );
  assert.equal((await file.download()).sha256, digest);
  assert.match(file.ranges[1], new RegExp('^bytes=' + prefix + '-'));
  assert.deepEqual(await readFile(file.destination), bytes);
});

test('a timeout after partial progress and a timed-out range request preserve the offset', async (t) => {
  const timeout = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  const file = await fixture(t, (range, attempt) => {
    if (attempt === 1) return interrupted(bytes.subarray(0, prefix), {}, timeout());
    if (attempt === 2) throw timeout();
    return partial(range);
  });
  assert.equal((await file.download()).sha256, digest);
  assert.match(file.ranges[1], new RegExp('^bytes=' + prefix + '-'));
  assert.equal(file.ranges[2], file.ranges[1]);
});

test('rejects a mismatched Content-Range and removes all partial output', async (t) => {
  const file = await fixture(t, (range, attempt) =>
    attempt === 1
      ? interrupted(bytes.subarray(0, prefix))
      : partial(range, { 'content-range': 'bytes 0-10/' + bytes.length }),
  );
  await assert.rejects(file.download());
  assert.ok(file.ranges.length >= 2);
  assert.deepEqual(await readdir(file.directory), []);
});

test('retries a temporary server failure but stops at lost access', async (t) => {
  const recovered = await fixture(t, (range, attempt) => {
    if (attempt === 1) return new Response(null, { status: 503 });
    return range ? partial(range) : new Response(bytes);
  });
  assert.equal((await recovered.download()).sha256, digest);

  const refused = await fixture(t, () => new Response(null, { status: 403 }));
  await assert.rejects(refused.download(), /403/);
  assert.equal(refused.ranges.length, 1);
  assert.deepEqual(await readdir(refused.directory), []);
});

test('a stable strong ETag permits range recovery for a legacy asset without a digest', async (t) => {
  const headers = { etag: '"fixed-revision"' };
  const file = await fixture(
    t,
    (range, attempt) =>
      attempt === 1 ? interrupted(bytes.subarray(0, prefix), headers) : partial(range, headers),
    null,
  );
  assert.equal((await file.download()).sha256, digest);
  assert.match(file.ranges[1], new RegExp('^bytes=' + prefix + '-'));
  assert.deepEqual(await readFile(file.destination), bytes);
});

test('a legacy asset with only a weak ETag retries the full representation', async (t) => {
  const headers = { etag: 'W/"revision"' };
  const file = await fixture(
    t,
    (_range, attempt) =>
      attempt === 1
        ? interrupted(Buffer.alloc(prefix, 0xff), headers)
        : new Response(bytes, { headers }),
    null,
  );
  assert.equal((await file.download()).sha256, digest);
  assert.deepEqual(file.ranges, [null, null]);
  assert.deepEqual(await readFile(file.destination), bytes);
});

test('a changed strong validator on a partial response cannot mix two legacy revisions', async (t) => {
  const file = await fixture(
    t,
    (range, attempt) => {
      if (attempt === 1) return interrupted(bytes.subarray(0, prefix), { etag: '"first"' });
      if (!range) return new Response(null, { status: 412 });
      return partial(range, { etag: '"second"' });
    },
    null,
  );
  await assert.rejects(file.download());
  assert.ok(file.ranges.length >= 2);
  assert.deepEqual(await readdir(file.directory), []);
});

test('recovery keeps progressing through five consecutively interrupted 206 responses', async (t) => {
  const slice = 8192;
  const file = await fixture(t, (range, attempt) => {
    if (attempt === 1) return interrupted(bytes.subarray(0, prefix));
    if (attempt <= 6) return partial(range, {}, slice);
    return partial(range);
  });
  assert.equal((await file.download()).sha256, digest);
  for (let i = 0; i <= 5; i++) {
    assert.match(file.ranges[i + 1], new RegExp('^bytes=' + (prefix + i * slice) + '-'));
  }
  assert.deepEqual(await readFile(file.destination), bytes);
});

test('a server that ignores the range and disconnects is retried with an ordinary full GET', async (t) => {
  const file = await fixture(t, (range, attempt) => {
    if (attempt === 1) return interrupted(bytes.subarray(0, prefix));
    if (attempt === 2) {
      assert.match(range, new RegExp('^bytes=' + prefix + '-'));
      return interrupted(bytes.subarray(0, 4096));
    }
    assert.equal(range, null);
    return new Response(bytes);
  });
  assert.equal((await file.download()).sha256, digest);
  assert.equal(file.ranges.length, 3);
  assert.deepEqual(await readFile(file.destination), bytes);
});

test('unavailability without any progress exhausts the retries and leaves no partial file', async (t) => {
  const file = await fixture(t, (_range, attempt) => {
    assert.ok(attempt <= 10, 'download retried indefinitely');
    return new Response(null, { status: 503 });
  });
  await assert.rejects(file.download(), /503/);
  assert.ok(file.ranges.length > 1);
  assert.deepEqual(await readdir(file.directory), []);
});

test('a full response with a conflicting strong ETag cannot replace the requested legacy revision', async (t) => {
  const file = await fixture(
    t,
    () => new Response(Buffer.alloc(bytes.length, 0xff), { headers: { etag: '"replacement"' } }),
    null,
    { etag: '"requested"' },
  );
  await assert.rejects(file.download());
  assert.deepEqual(await readdir(file.directory), []);
});
