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

test('CLI and both stdio protocols can quote a submission payload against a strict site', async () => {
  const inputs = { brief: 'A warm grey living room', model: 'basic', scene: 'interior', image_count: 1 };
  const submission = Object.freeze({ ...inputs, request_id: 'living-room-1' });
  const quote = Object.freeze({ tool: 'render_architecture', arguments: submission });
  const received = [];
  const bridge = upstream(({ id, params }) => {
    received.push([params.name, params.arguments]);
    const invalid = params.name === 'quote_tool' && 'request_id' in params.arguments.arguments;
    const result = invalid
      ? { isError: true, content: [{ type: 'text', text: 'Invalid generation parameters' }] }
      : { structuredContent: { accepted: true } };
    return Response.json({ jsonrpc: '2.0', id, result: { resultType: 'complete', ...result } });
  });
  assert.deepEqual(await bridge.call('quote_tool', quote), { accepted: true });
  for (const metadata of [{}, modern]) {
    const reply = await bridge.handle({
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { ...metadata, name: 'quote_tool', arguments: quote },
    });
    assert.deepEqual(reply.result.structuredContent, { accepted: true });
  }
  assert.deepEqual(received, Array.from({ length: 3 }, () => ['quote_tool', { tool: quote.tool, arguments: inputs }]));
  await bridge.call(quote.tool, submission);
  assert.deepEqual(received.at(-1), [quote.tool, { ...inputs, request_id: 'living-room-1' }]);
});

test('quote compatibility preserves unknown and deeply nested inputs for site validation', async () => {
  const presetInputs = { parameters: { request_id: 'custom-preset-field' }, unexpected: true };
  const bridge = upstream(({ id, params }) => {
    assert.deepEqual(params.arguments, { tool: 'run_design_preset', arguments: presetInputs });
    return Response.json({
      jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'Unknown field: unexpected' }] },
    });
  });
  await assert.rejects(bridge.call('quote_tool', {
    tool: 'run_design_preset',
    arguments: { ...presetInputs, request_id: 'submit-only' },
  }), /Unknown field: unexpected/);
});

test('discovery explains the quote/submit ID boundary while preserving site-provided guidance', async () => {
  for (const description of [undefined, 'Site-specific quote guidance.']) {
    const argumentsSchema = description ? { type: 'object', description } : { type: 'object' };
    const unrelated = { name: 'another_tool', inputSchema: { properties: { arguments: { type: 'object' } } } };
    const bridge = upstream(({ id }) => Response.json({
      jsonrpc: '2.0', id, result: {
        resultType: 'complete',
        tools: [
          { name: 'quote_tool', inputSchema: { properties: { arguments: argumentsSchema } } },
          unrelated,
        ],
      },
    }));
    const cli = await bridge.remote('tools/list');
    const stdio = await bridge.handle({ ...list, params: modern });
    for (const result of [cli, stdio.result]) {
      const instructions = result.tools[0].inputSchema.properties.arguments.description;
      if (description) assert.equal(instructions, description);
      else {
        assert.match(instructions, /request_id/);
        assert.match(instructions, /submit/i);
      }
      assert.deepEqual(result.tools[1], unrelated);
    }
  }
});
