import { createInterface } from 'node:readline';
import manifest from '../package.json' with { type: 'json' };
export const version = '2026-07-28';
const legacy = ['2025-11-25', '2025-06-18', '2025-03-26'];
const info = { name: manifest.name, version: manifest.version };
const prefix = 'io.modelcontextprotocol/';
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
export class Bridge {
  constructor(session) {
    this.session = session;
    this.counter = 0;
  }
  async remote(method, params = {}, signal) {
    const id = ++this.counter;
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': version,
      'Mcp-Method': method,
    };
    if (method === 'tools/call') headers['Mcp-Name'] = params.name;
    const body = {
      jsonrpc: '2.0',
      id,
      method,
      params: {
        ...params,
        _meta: {
          [prefix + 'protocolVersion']: version,
          [prefix + 'clientInfo']: info,
          [prefix + 'clientCapabilities']: {},
        },
      },
    };
    const res = await this.session.request(this.session.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(240000)])
        : AbortSignal.timeout(240000),
    });
    const reply = await res.json().catch((error) => {
      if (error instanceof SyntaxError) return null;
      throw error;
    });
    const matching = isObject(reply) && reply.jsonrpc === '2.0' && reply.id === id;
    if (
      matching &&
      !('result' in reply) &&
      isObject(reply.error) &&
      Number.isSafeInteger(reply.error.code) &&
      typeof reply.error.message === 'string'
    ) {
      const error = new Error(reply.error.message);
      error.rpcCode = reply.error.code;
      error.rpcData = reply.error.data;
      throw error;
    }
    if (!res.ok) throw new Error('3DR returned HTTP ' + res.status + '.');
    if (!matching || 'error' in reply || !isObject(reply.result)) throw new Error('Invalid MCP response.');
    return reply.result;
  }
  async call(name, args) {
    const result = await this.remote('tools/call', { name, arguments: args });
    if (result.isError) throw new Error(result.content?.[0]?.text || 'Media tool failed.');
    return result.structuredContent;
  }
  async handle(message, signal) {
    const id = message?.id ?? null;
    const error = (code, msg, data) => ({
      jsonrpc: '2.0',
      id,
      error: { code, message: msg, ...(data !== undefined ? { data } : {}) },
    });
    if (
      !isObject(message) ||
      message.jsonrpc !== '2.0' ||
      typeof message.method !== 'string' ||
      (message.id !== undefined && !(typeof id === 'string' || Number.isSafeInteger(id)))
    )
      return error(-32600, 'Invalid JSON-RPC request.');
    if (message.id === undefined) return;
    const { method } = message,
      params = message.params ?? {};
    const requested = params._meta?.[prefix + 'protocolVersion'];
    if (requested && requested !== version)
      return error(-32022, 'Unsupported protocol version', {
        supported: [version, ...legacy],
        requested,
      });
    const current = requested === version;
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    if (method === 'initialize' && !current)
      return ok({
        protocolVersion: legacy.includes(params.protocolVersion) ? params.protocolVersion : legacy[0],
        capabilities: { tools: {} },
        serverInfo: info,
      });
    if (method === 'server/discover')
      return ok({
        resultType: 'complete',
        supportedVersions: [version, ...legacy],
        capabilities: { tools: {} },
        _meta: { [prefix + 'serverInfo']: info },
      });
    if (method === 'ping') return ok(current ? { resultType: 'complete' } : {});
    if (!['tools/call', 'tools/list'].includes(method)) return error(-32601, 'Method not found');
    try {
      const result = await this.remote(method, params, signal);
      if (current) return ok(result);
      const { resultType, ...rest } = result;
      return ok(rest);
    } catch (e) {
      return error(e.rpcCode ?? -32603, e.message ?? 'Connection failed.', e.rpcData);
    }
  }
}
export async function serve(bridge, input = process.stdin, output = process.stdout) {
  const pending = new Map();
  const tasks = new Set();
  const reply = (value) => {
    if (value !== undefined) output.write(JSON.stringify(value) + '\n');
  };
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let msg;
    try {
      if (Buffer.byteLength(line) > 1048576) throw new Error();
      msg = JSON.parse(line);
    } catch {
      reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON message.' } });
      continue;
    }
    if (msg?.method === 'notifications/cancelled' && msg.id === undefined) {
      if (msg.jsonrpc === '2.0') pending.get(msg.params?.requestId)?.abort();
      continue;
    }
    if (tasks.size >= 32 || (msg?.id !== undefined && pending.has(msg.id))) {
      if (msg?.id !== undefined)
        reply({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32600, message: 'Too many pending requests or duplicate request id.' },
        });
      continue;
    }
    const controller = new AbortController();
    if (msg?.id !== undefined) pending.set(msg.id, controller);
    const task = bridge
      .handle(msg, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) reply(value);
      })
      .finally(() => {
        pending.delete(msg?.id);
        tasks.delete(task);
      });
    tasks.add(task);
  }
  await Promise.allSettled(tasks);
}
