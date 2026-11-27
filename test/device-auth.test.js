import assert from 'node:assert/strict';
import test from 'node:test';
import { Session } from '../src/auth.js';
import { deviceLogin, hasLocalBrowser } from '../src/device-auth.js';

const endpoint = new URL('https://design.example/mcp');
const meta = {
  issuer: endpoint.origin,
  code_challenge_methods_supported: ['S256'],
  authorization_endpoint: endpoint.origin + '/oauth/authorize',
  revocation_endpoint: endpoint.origin + '/oauth/revoke',
  token_endpoint: endpoint.origin + '/oauth/token',
  device_authorization_endpoint: endpoint.origin + '/oauth/device_authorization',
  scopes_supported: ['runs:read'],
};
const challenge = {
  device_code: 'private-poller',
  user_code: 'ABCD-EFGH',
  expires_in: 600,
  interval: 1,
  verification_uri: endpoint.origin + '/account/mcp/device',
  verification_uri_complete: endpoint.origin + '/account/mcp/device?user_code=ABCD-EFGH',
};

test('connect with an approval on a separate device, save tokens on the agent, reuse the profile', async () => {
  const messages = [];
  const forms = [];
  let saved;
  const vault = {
    locked: (task) => task(),
    read: () => saved,
    write: (value) => {
      saved = value;
    },
  };
  const session = new Session(endpoint, vault, {
    manual: true,
    open: () => assert.fail('A remote terminal has no browser'),
    log: (value) => messages.push(value),
    async fetcher(url, options) {
      assert.equal(options.redirect, 'error');
      const path = new URL(url).pathname;
      if (path === '/.well-known/oauth-protected-resource/mcp')
        return Response.json({ resource: endpoint.href, authorization_servers: [meta.issuer] });
      if (path === '/.well-known/oauth-authorization-server') return Response.json(meta);
      forms.push(Object.fromEntries(options.body));
      if (path === '/oauth/device_authorization') return Response.json(challenge);
      assert.equal(path, '/oauth/token');
      return Response.json({
        token_type: 'Bearer',
        access_token: 'access-example',
        refresh_token: 'refresh-example',
        expires_in: 600,
      });
    },
  });

  assert.equal(await session.connect(), 'access-example');
  assert.equal(await session.token(), 'access-example');
  assert.equal(saved.refresh, 'refresh-example');
  assert.deepEqual(forms, [
    { client_id: '3dr-media-mcp', resource: endpoint.href, scope: 'runs:read' },
    {
      client_id: '3dr-media-mcp',
      resource: endpoint.href,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: challenge.device_code,
    },
  ]);
  assert.ok(messages[0].includes(challenge.verification_uri));
  assert.ok(messages[0].includes(challenge.user_code));
  assert.doesNotMatch(messages.join('\n'), /private-poller|access-example|refresh-example/);
});

function pollFixture(replies, response = challenge) {
  const delays = [];
  const opened = [];
  let cleared = false;
  const session = {
    endpoint,
    loginCommand: '3dr --profile office login',
    log() {},
    open: (url) => opened.push(url),
    vault: {
      clear: () => {
        cleared = true;
      },
    },
    fetcher: () => Response.json(response),
    exchange: () => {
      const reply = replies.shift();
      if (reply === 'ok') return 'access';
      assert.ok(reply);
      if (reply instanceof Error) throw reply;
      throw Object.assign(new Error('token error'), { oauthCode: reply });
    },
  };
  return {
    delays,
    opened,
    wasCleared: () => cleared,
    run: () =>
      deviceLogin(session, meta, {}, async (ms) => {
        delays.push(ms);
      }),
  };
}

test('desktop opens only the verification page; polling honors pending, slowdown and connection timeout', async () => {
  const fixture = pollFixture([
    'authorization_pending',
    'slow_down',
    new DOMException('timeout', 'TimeoutError'),
    'ok',
  ]);
  assert.equal(await fixture.run(), 'access');
  assert.deepEqual(fixture.opened, [challenge.verification_uri_complete]);
  assert.deepEqual(fixture.delays, [1000, 1000, 6000, 12000]);
});

test('denial stops background prompts and expiry tells the caller how to reconnect', async () => {
  const denied = pollFixture(['access_denied']);
  await assert.rejects(denied.run(), /declined/);
  assert.equal(denied.wasCleared(), true);
  const expired = pollFixture(['expired_token']);
  await assert.rejects(expired.run(), /3dr --profile office login/);
  assert.equal(expired.wasCleared(), false);
  const unknown = pollFixture(['invalid_client']);
  await assert.rejects(unknown.run(), /token error/);
  assert.deepEqual(unknown.delays, [1000]);
});

test('untrusted verification links are never opened or printed', async () => {
  for (const changed of [
    { verification_uri: 'https://elsewhere.example/verify' },
    { verification_uri_complete: 'https://elsewhere.example/verify?user_code=ABCD-EFGH' },
    { verification_uri_complete: challenge.verification_uri_complete + '&device_code=private-poller' },
    { user_code: 'ab\ncde' },
  ]) {
    const fixture = pollFixture([], { ...challenge, ...changed });
    await assert.rejects(fixture.run(), /Invalid device/);
    assert.deepEqual(fixture.opened, []);
    assert.deepEqual(fixture.delays, []);
  }
});

test('required device login on an older site exits without creating a local listener', async () => {
  const session = new Session(endpoint, {}, { loginMode: 'device' });
  session.metadata = async () => ({ ...meta, device_authorization_endpoint: undefined });
  await assert.rejects(session.login(), /does not offer device login/);
});

test('only local graphical sessions can launch a browser', () => {
  assert.equal(hasLocalBrowser({ SSH_CONNECTION: 'fixture' }, 'darwin'), false);
  assert.equal(hasLocalBrowser({}, 'linux'), false);
  assert.equal(hasLocalBrowser({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux'), true);
  assert.equal(hasLocalBrowser({}, 'win32'), true);
});

test('explicit loopback on an upgraded site retains same-computer PKCE and exchanges the callback', async () => {
  let opened = false;
  const session = new Session(
    endpoint,
    { write() {} },
    {
      loginMode: 'loopback',
      log() {},
      open: async (url) => {
        const auth = new URL(url).searchParams;
        assert.equal(auth.get('code_challenge_method'), 'S256');
        const callback = new URL(auth.get('redirect_uri'));
        assert.equal(callback.hostname, '127.0.0.1');
        callback.search = new URLSearchParams({
          state: auth.get('state'),
          iss: meta.issuer,
          code: 'local-code',
        });
        opened = true;
        await fetch(callback, { redirect: 'manual' });
      },
      fetcher: async (url, options) => {
        assert.equal(url, meta.token_endpoint);
        assert.equal(options.body.get('grant_type'), 'authorization_code');
        assert.ok(options.body.get('code_verifier'));
        return Response.json({
          token_type: 'Bearer',
          access_token: 'local-access',
          refresh_token: 'local-refresh',
          expires_in: 600,
        });
      },
    },
  );
  session.metadata = async () => meta;
  assert.equal(await session.login(), 'local-access');
  assert.equal(opened, true);
});
