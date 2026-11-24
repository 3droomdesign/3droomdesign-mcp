import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { Bridge, serve, version } from '../src/bridge.js';

const list = { jsonrpc: '2.0', id: 'host-id', method: 'tools/list' };
const modern = {
  _meta: {
    'io.modelcontextprotocol/protocolVersion': version,
    'io.modelcontextprotocol/clientCapabilities': {},
  },
};
function upstream(respond) {
  return new Bridge({
    endpoint: new URL('https://media.example/mcp'),
    request: async (_url, { body, signal }) => respond(JSON.parse(body), signal),
  });
}

test('both host protocols receive correlated upstream errors and their recovery data', async () => {
  const error = {
    code: -32022,
    message: 'Unsupported protocol version',
    data: { requested: version, supported: ['2025-11-25'] },
  };
  for (const params of [{}, modern]) {
    const bridge = upstream(({ id }) => Response.json({ jsonrpc: '2.0', id, error }, { status: 400 }));
    assert.deepEqual(await bridge.handle({ ...list, params }), { jsonrpc: '2.0', id: list.id, error });
  }
  const inBand = { code: -32602, message: 'Invalid parameters', data: false };
  const bridge = upstream(({ id }) => Response.json({ jsonrpc: '2.0', id, error: inBand }));
  assert.deepEqual((await bridge.handle(list)).error, inBand);
});

test('a proxy error or mismatched response is never treated as the request’s RPC error', async () => {
  const proxy = upstream(() => new Response('<html>Gateway error</html>', { status: 502 }));
  assert.deepEqual((await proxy.handle(list)).error, { code: -32603, message: '3DR returned HTTP 502.' });
  const mismatched = upstream(() =>
    Response.json(
      {
        jsonrpc: '2.0',
        id: 999,
        error: { code: -32022, message: 'Unrelated' },
      },
      { status: 400 },
    ),
  );
  assert.deepEqual((await mismatched.handle(list)).error, {
    code: -32603,
    message: '3DR returned HTTP 400.',
  });
  const invalid = upstream(() => new Response('not JSON'));
  assert.equal((await invalid.handle(list)).error.message, 'Invalid MCP response.');
});

test('a cancelled stdio request is aborted without a late reply and subsequent requests work', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.setEncoding('utf8').on('data', (chunk) => {
    text += chunk;
  });
  const started = Promise.withResolvers();
  const bridge = upstream((_request, signal) => {
    started.resolve(signal);
    return new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    );
  });
  const serving = serve(bridge, input, output);
  const send = (msg) => input.write(JSON.stringify(msg) + '\n');
  send(list);
  const signal = await started.promise;
  send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: list.id } });
  send({ jsonrpc: '2.0', method: 'ping', id: 'next' });
  input.end();
  await serving;
  assert.equal(signal.aborted, true);
  assert.deepEqual(text.trim().split('\n').map(JSON.parse), [{ jsonrpc: '2.0', id: 'next', result: {} }]);
});
