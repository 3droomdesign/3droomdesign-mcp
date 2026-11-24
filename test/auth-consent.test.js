import assert from 'node:assert/strict';
import test from 'node:test';
import { Session } from '../src/auth.js';

const endpoint = new URL('https://media.example/mcp');

function testVault() {
  let entry = null;
  let signedOut = false;
  return {
    locked: (task) => task(),
    read: async () => entry,
    write: async (value) => {
      entry = value;
      signedOut = false;
    },
    clear: async () => {
      entry = null;
      signedOut = true;
    },
    autoLoginBlocked: async () => signedOut,
  };
}

test('logout without a credential prevents background consent on a new host', async () => {
  const vault = testVault();
  const options = {
    loginCommand: '3dr --profile studio login',
    fetcher: () => assert.fail('Logout and blocked requests must not contact the website'),
  };
  await new Session(endpoint, vault, options).logout();
  const nextHost = new Session(endpoint, vault, options);
  await assert.rejects(nextHost.token(), {
    loginRequired: true,
    message: 'Sign in with 3dr --profile studio login.',
  });
});

test('a website denial blocks background prompts until an explicit login succeeds', async () => {
  const vault = testVault();
  let browserOpens = 0;
  const options = {
    log() {},
    async open(address) {
      browserOpens++;
      const auth = new URL(address).searchParams;
      const callback = new URL(auth.get('redirect_uri'));
      callback.search = new URLSearchParams({
        state: auth.get('state'),
        iss: endpoint.origin,
        ...(browserOpens === 1 ? { error: 'access_denied' } : { code: 'fixture' }),
      });
      await fetch(callback, { redirect: 'manual' });
    },
    async fetcher(url) {
      switch (new URL(url).pathname) {
        case '/.well-known/oauth-protected-resource/mcp':
          return Response.json({ resource: endpoint.href, authorization_servers: [endpoint.origin] });
        case '/.well-known/oauth-authorization-server':
          return Response.json({
            issuer: endpoint.origin,
            code_challenge_methods_supported: ['S256'],
            authorization_endpoint: endpoint.origin + '/authorize',
            token_endpoint: endpoint.origin + '/token',
            revocation_endpoint: endpoint.origin + '/revoke',
          });
        case '/token':
          return Response.json({
            token_type: 'Bearer',
            access_token: 'access',
            refresh_token: 'refresh',
            expires_in: 600,
          });
        default:
          assert.fail('Unexpected website request');
      }
    },
  };
  await assert.rejects(new Session(endpoint, vault, options).token(), /Authorization declined/);
  const nextHost = new Session(endpoint, vault, options);
  await assert.rejects(nextHost.token(), { loginRequired: true });
  assert.equal(browserOpens, 1);
  assert.equal(await nextHost.connect(), 'access');
  assert.equal(await nextHost.token(), 'access');
  assert.equal(browserOpens, 2);
  assert.equal(await vault.autoLoginBlocked(), false);
});
