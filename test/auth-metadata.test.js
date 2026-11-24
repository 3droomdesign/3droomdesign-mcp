import assert from 'node:assert/strict';
import test from 'node:test';
import { Session } from '../src/auth.js';

const site = new URL('https://staging.example/mcp');
const resourcePath = '/.well-known/oauth-protected-resource/mcp';
const issuerPath = '/.well-known/oauth-authorization-server';

async function checkFailure({ path = resourcePath, status, body, contentType, language = 'en', message }) {
  const requested = [];
  const fetcher = async (url, options) => {
    assert.equal(url.origin, site.origin);
    assert.equal(options.headers.accept, 'application/json');
    requested.push(url.pathname);
    if (url.pathname === path)
      return new Response(body, { status, headers: { 'content-type': contentType || 'text/plain' } });
    return Response.json({ resource: site.href, authorization_servers: [site.origin] });
  };
  const session = new Session(site, {}, { language, fetcher });
  await assert.rejects(session.metadata(), (error) => {
    assert.match(error.message, message);
    assert.ok(error.message.includes(site.origin + path));
    assert.ok(error.message.includes(`HTTP ${status}`));
    assert.equal(error.loginRequired, undefined);
    return true;
  });
  assert.deepEqual(requested, path === resourcePath ? [resourcePath] : [resourcePath, issuerPath]);
}

test('discovery identifies a missing MCP route or an HTML application fallback on the selected site', async () => {
  await checkFailure({ status: 404, language: 'zh-CN', message: /未提供 MCP OAuth 元数据.*测试站账户/ });
  await checkFailure({
    path: issuerPath,
    status: 200,
    body: '<!doctype html><title>Home</title>',
    message: /did not provide MCP OAuth metadata.*test site.*setup command/,
  });
  await checkFailure({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<div id="app"></div>',
    message: /did not provide MCP OAuth metadata/,
  });
});

test('discovery distinguishes restricted access, temporary errors, and invalid documents', async () => {
  for (const status of [401, 403])
    await checkFailure({ status, body: '<html/>', message: /restricted access/ });
  for (const status of [429, 503])
    await checkFailure({ status, body: '<html/>', message: /temporarily unavailable/ });
  await checkFailure({ status: 200, body: '{bad', message: /Invalid MCP OAuth metadata document/ });
});

test('a network failure identifies the discovery URL without claiming the route is missing', async () => {
  const cause = new TypeError('fetch failed');
  const session = new Session(site, {}, { fetcher: () => Promise.reject(cause) });
  await assert.rejects(session.metadata(), (error) => {
    assert.equal(error.cause, cause);
    assert.match(error.message, /network and site address/);
    return error.message.includes(site.origin + resourcePath);
  });
});
