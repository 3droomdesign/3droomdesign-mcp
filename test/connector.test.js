import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEndpoint, Session, scopes, supportedScopes } from '../src/auth.js';
import { Bridge, version } from '../src/bridge.js';
import { downloadFile } from '../src/files.js';

test('requests only scopes supported by the endpoint and preserves the legacy fallback', () => {
  assert.equal(supportedScopes({ scopes_supported: scopes.split(' ') }), scopes);
  assert.equal(supportedScopes({ scopes_supported: ['library:read', 'unknown'] }), 'library:read');
  assert.ok(supportedScopes({}).includes('results:read'));
  assert.ok(!supportedScopes({}).includes('library:read'));
});

test('limits the credential audience to a secure, explicit resource', () => {
  for (const url of [
    'http://example.org/mcp',
    'https://u@example.org/mcp',
    'https://example.org/mcp?token=x',
    'file:///mcp',
  ])
    assert.throws(() => parseEndpoint(url));
  assert.equal(parseEndpoint('http://127.0.0.1:8000/mcp').pathname, '/mcp');
});

test('PKCE callback, scoped RPC, persisted session, refresh and revoke', async () => {
  let origin,
    challenge,
    stored,
    exchanges = 0,
    opens = 0,
    revoked = false;
  const vault = {
    locked: (fn) => fn(),
    read: async () => stored,
    write: async (v) => {
      stored = v;
    },
    clear: async () => {
      stored = null;
    },
  };
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    const send = (value) => res.end(JSON.stringify(value));
    if (req.url === '/.well-known/oauth-protected-resource/mcp')
      return send({ resource: origin + '/mcp', authorization_servers: [origin] });
    if (req.url === '/.well-known/oauth-authorization-server')
      return send({
        issuer: origin,
        code_challenge_methods_supported: ['S256'],
        authorization_endpoint: origin + '/auth',
        token_endpoint: origin + '/token',
        revocation_endpoint: origin + '/revoke',
      });
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    if (req.url === '/token') {
      const p = new URLSearchParams(body);
      assert.equal(p.get('resource'), origin + '/mcp');
      if (p.get('grant_type') === 'authorization_code')
        assert.equal(createHash('sha256').update(p.get('code_verifier')).digest('base64url'), challenge);
      else assert.equal(p.get('refresh_token'), 'refresh1');
      exchanges++;
      return send({
        token_type: 'Bearer',
        access_token: 'access' + exchanges,
        refresh_token: 'refresh' + exchanges,
        expires_in: 600,
      });
    }
    if (req.url === '/revoke') {
      revoked = true;
      return send({});
    }
    assert.equal(req.headers.authorization, 'Bearer access' + exchanges);
    assert.equal(req.headers['mcp-method'], 'tools/list');
    const rpc = JSON.parse(body);
    assert.equal(rpc.params._meta['io.modelcontextprotocol/protocolVersion'], version);
    return send({ jsonrpc: '2.0', id: rpc.id, result: { resultType: 'complete', tools: [] } });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = 'http://127.0.0.1:' + server.address().port;
  let callback;
  const session = new Session(parseEndpoint(origin + '/mcp'), vault, {
    log() {},
    open(link) {
      opens++;
      const auth = new URL(link);
      challenge = auth.searchParams.get('code_challenge');
      const url = new URL(auth.searchParams.get('redirect_uri'));
      url.search = new URLSearchParams({ code: 'one-use', iss: origin, state: 'bad-state' }).toString();
      callback = (async () => {
        assert.equal((await fetch(url, { redirect: 'manual' })).status, 400);
        url.searchParams.set('state', auth.searchParams.get('state'));
        const reply = await fetch(url, { redirect: 'manual' });
        assert.equal(reply.status, 303);
        assert.equal(new URL(reply.headers.get('location')).origin, origin);
      })();
    },
  });
  try {
    const bridge = new Bridge(session);
    const handshake = await bridge.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' },
    });
    assert.equal(handshake.result.protocolVersion, '2025-11-25');
    assert.equal(handshake.result.serverInfo.name, '3droomdesign-mcp');
    assert.equal(opens, 0);
    assert.deepEqual((await bridge.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result, {
      tools: [],
    });
    await callback;
    const next = new Session(session.endpoint, vault, {
      open() {
        throw new Error('Unexpected authorization');
      },
    });
    assert.equal(await next.token(), 'access1');
    stored.expires = 0;
    assert.equal(await next.token(), 'access2');
    await next.logout();
    assert.equal(revoked, true);
    assert.equal(stored, null);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test('a revoked grant closes background access while explicit login can obtain a new grant', async () => {
  const issuer = 'https://media.example';
  let entry = { access: 'previous', refresh: 'expired', expires: Date.now() + 600000 };
  let browserOpens = 0;
  let signedOut = false;
  const vault = {
    locked: (operation) => operation(),
    read: async () => entry,
    write: async (value) => {
      entry = value;
    },
    clear: async () => {
      entry = null;
      signedOut = true;
    },
    autoLoginBlocked: async () => signedOut,
  };
  const session = new Session(parseEndpoint(issuer + '/mcp'), vault, {
    autoLogin: false,
    log() {},
    async open(address) {
      browserOpens++;
      const query = new URL(address).searchParams;
      const callback = new URL(query.get('redirect_uri'));
      callback.search = new URLSearchParams({ iss: issuer, state: query.get('state'), code: 'fixture' });
      const response = await fetch(callback, { redirect: 'manual' });
      assert.equal(response.status, 303);
    },
    async fetcher(input, options) {
      const path = new URL(input).pathname;
      if (path.endsWith('protected-resource/mcp'))
        return Response.json({ resource: issuer + '/mcp', authorization_servers: [issuer] });
      if (path.endsWith('authorization-server'))
        return Response.json({
          issuer,
          code_challenge_methods_supported: ['S256'],
          authorization_endpoint: issuer + '/oauth/authorize',
          token_endpoint: issuer + '/oauth/token',
          revocation_endpoint: issuer + '/oauth/revoke',
        });
      if (path === '/mcp') return new Response(null, { status: 401 });
      if (options.body.get('refresh_token') === 'expired')
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({
        token_type: 'Bearer',
        access_token: 'new',
        refresh_token: 'next',
        expires_in: 600,
      });
    },
  });
  await assert.rejects(session.request(session.endpoint, { method: 'POST' }), { invalidGrant: true });
  assert.equal(entry, null);
  await assert.rejects(session.token(), { loginRequired: true });
  assert.equal(browserOpens, 0);
  session.autoLogin = true;
  await assert.rejects(session.token(), { loginRequired: true });
  assert.equal(browserOpens, 0);
  entry = { access: 'stale', refresh: 'expired', expires: Date.now() + 100000 };
  assert.equal(await session.connect(), 'new');
  assert.equal(entry.access, 'new');
  assert.equal(browserOpens, 1);
  assert.equal(await session.connect(), 'new');
  assert.equal(browserOpens, 1);
});

test('saves owned bytes once, validates the digest and keeps existing files', async () => {
  const directory = await mkdtemp(join(tmpdir(), '3dr-mcp-files-'));
  const dest = join(directory, 'image.png'),
    bytes = Buffer.from('verified image');
  const ref = 'asset_example_0',
    endpoint = new URL('https://media.example/mcp');
  const file = {
    download_url: endpoint.href + '/assets/' + ref,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const bridge = {
    call: async () => file,
    session: { endpoint, request: async () => new Response(bytes) },
  };
  try {
    assert.equal((await downloadFile(bridge, ref, dest)).size, bytes.length);
    await writeFile(dest, 'original');
    await assert.rejects(downloadFile(bridge, ref, dest));
    assert.equal(await readFile(dest, 'utf8'), 'original');
    file.sha256 = 'wrong';
    await assert.rejects(downloadFile(bridge, ref, join(directory, 'bad')), /verification/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
