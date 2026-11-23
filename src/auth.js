import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';

// The registered OAuth identifier also applies to grants created by earlier CLI versions.
export const clientId = '3dr-media-mcp';
const originalScopes =
  'render:generate floorplan:generate video:generate uploads:write runs:read results:read account:read credits:read';
export const scopes =
  originalScopes + ' presets:generate tour:generate cad:generate catalog:read library:read';
export function supportedScopes(metadata) {
  if (!Array.isArray(metadata.scopes_supported)) return originalScopes;
  return scopes
    .split(' ')
    .filter((scope) => metadata.scopes_supported.includes(scope))
    .join(' ');
}
export function parseEndpoint(value) {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
    url.pathname !== '/mcp' ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw new Error('Use an HTTPS /mcp endpoint, or HTTP on loopback.');
  return url;
}
// Only the website origin is configurable in a developer's process environment.
export function siteEndpoint(override = process.env.THREEDR_SITE_ORIGIN, legacy) {
  const official = 'https://3droomdesign.ai';
  const origin = new URL(override || official);
  if (origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash)
    throw new Error('Expected a website origin.');
  const endpoint = parseEndpoint(origin.origin + '/mcp');
  // A v0.2 configuration can identify this site but cannot select a different audience.
  if (legacy && legacy !== official + '/mcp' && parseEndpoint(legacy).href !== endpoint.href)
    throw new Error(
      'This older MCP configuration targets a different site. Update the local host configuration.',
    );
  return endpoint;
}
export function openBrowser(url) {
  const [program, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  const child = spawn(program, args, { stdio: 'ignore', detached: true, shell: false });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error('Browser did not open.'))));
    child.unref();
  });
}
export function deviceVault(endpoint, profile) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(profile)) throw new Error('Invalid local profile name.');
  const key = createHash('sha256')
    .update(endpoint.href + '\n' + profile)
    .digest('hex');
  const directory = join(homedir(), '.3dr-media-mcp', key);
  const signedOut = join(directory, 'signed-out');
  let entry;
  async function credential() {
    if (!entry) {
      const { AsyncEntry } = await import('@napi-rs/keyring');
      entry = new AsyncEntry('3D Room Design MCP', key, { linux: { store: 'secret-service' } });
    }
    return entry;
  }
  return {
    async read() {
      const value = await (await credential()).getPassword();
      return value ? JSON.parse(value) : null;
    },
    async write(value) {
      await (await credential()).setPassword(JSON.stringify(value));
      await rm(signedOut, { force: true });
    },
    async clear() {
      // Keep background hosts from reopening consent after website revocation or logout.
      await writeFile(signedOut, '', { mode: 0o600 });
      await (await credential()).deletePassword();
    },
    async autoLoginBlocked() {
      try {
        await access(signedOut);
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    },
    async locked(task) {
      // Serialize rotating refreshes across all hosts using the same OS credential.
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const unlock = await lockfile.lock(directory, {
        stale: 30000,
        retries: { retries: 210, factor: 1, minTimeout: 1000, maxTimeout: 1000 },
      });
      try {
        return await task();
      } finally {
        await unlock();
      }
    },
  };
}
const random = () => randomBytes(32).toString('base64url');
export class Session {
  constructor(
    endpoint,
    vault,
    {
      open = openBrowser,
      log = (message) => process.stderr.write(message + '\n'),
      fetcher = fetch,
      manual = false,
      autoLogin = true,
      language = 'en',
    } = {},
  ) {
    this.endpoint = endpoint;
    this.vault = vault;
    this.open = open;
    this.log = log;
    this.fetcher = fetcher;
    this.manual = manual;
    this.autoLogin = autoLogin;
    this.language = language;
  }
  async metadata() {
    if (this.metadataCache) return this.metadataCache;
    const read = async (path) => {
      const response = await this.fetcher(new URL(path, this.endpoint), {
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error('The site did not return MCP authorization metadata.');
      return response.json();
    };
    const resource = await read('/.well-known/oauth-protected-resource/mcp');
    if (
      resource.resource !== this.endpoint.href ||
      !resource.authorization_servers?.includes(this.endpoint.origin)
    )
      throw new Error('Unexpected MCP resource identity.');
    const meta = await read('/.well-known/oauth-authorization-server');
    if (meta.issuer !== this.endpoint.origin || !meta.code_challenge_methods_supported?.includes('S256'))
      throw new Error('Unexpected authorization server identity.');
    for (const key of ['authorization_endpoint', 'token_endpoint', 'revocation_endpoint']) {
      const u = new URL(meta[key]);
      if (u.origin !== meta.issuer || u.username || u.password || u.hash)
        throw new Error('Invalid OAuth endpoint.');
    }
    this.metadataCache = meta;
    return meta;
  }
  async exchange(parameters) {
    const meta = await this.metadata();
    const res = await this.fetcher(meta.token_endpoint, {
      method: 'POST',
      body: new URLSearchParams({ client_id: clientId, resource: this.endpoint.href, ...parameters }),
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const problem = await res.json().catch(() => ({}));
      const error = new Error(
        problem.error === 'invalid_grant'
          ? this.language === 'zh-CN'
            ? '授权已到期或被撤销，请运行 3dr login。'
            : 'Authorization expired or revoked. Run 3dr login.'
          : 'The token request failed (' + res.status + ').',
      );
      error.invalidGrant = problem.error === 'invalid_grant';
      throw error;
    }
    const token = await res.json();
    if (
      !token.access_token ||
      !token.refresh_token ||
      token.token_type?.toLowerCase() !== 'bearer' ||
      !Number.isFinite(token.expires_in) ||
      token.expires_in <= 0
    )
      throw new Error('Invalid token response.');
    const stored = {
      access: token.access_token,
      refresh: token.refresh_token,
      expires: Date.now() + token.expires_in * 1000,
    };
    await this.vault.write(stored);
    return stored.access;
  }
  async login() {
    const meta = await this.metadata();
    const verifier = random(),
      state = random(),
      challenge = createHash('sha256').update(verifier).digest('base64url');
    const server = createServer();
    server.requestTimeout = 15000;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const redirect = 'http://127.0.0.1:' + server.address().port + '/callback';
    const url = new URL(meta.authorization_endpoint);
    url.search = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirect,
      resource: this.endpoint.href,
      scope: supportedScopes(meta),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    try {
      return await new Promise((resolve, reject) => {
        let used = false;
        const timeout = setTimeout(
          () =>
            reject(
              new Error(
                this.language === 'zh-CN'
                  ? '授权超时，请重新运行 3dr login。'
                  : 'Authorization timed out. Run 3dr login again.',
              ),
            ),
          180000,
        );
        server.once('close', () => clearTimeout(timeout));
        server.on('request', async (req, res) => {
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Referrer-Policy', 'no-referrer');
          let callback;
          try {
            callback = new URL(req.url, 'http://127.0.0.1');
          } catch {
            res.writeHead(400).end();
            return;
          }
          if (
            req.method !== 'GET' ||
            req.headers.host !== new URL(redirect).host ||
            callback.pathname !== '/callback' ||
            callback.searchParams.get('state') !== state ||
            callback.searchParams.get('iss') !== meta.issuer ||
            used
          ) {
            res.writeHead(400).end();
            return;
          }
          used = true;
          try {
            if (callback.searchParams.has('error') || !callback.searchParams.get('code'))
              throw new Error(this.language === 'zh-CN' ? '授权已拒绝。' : 'Authorization declined.');
            const access = await this.exchange({
              grant_type: 'authorization_code',
              code: callback.searchParams.get('code'),
              redirect_uri: redirect,
              code_verifier: verifier,
            });
            res.writeHead(303, { Location: this.endpoint.origin + '/account/mcp?connected=1' }).end();
            resolve(access);
          } catch (error) {
            res.writeHead(400).end();
            reject(error);
          }
        });
        const manualLink = () =>
          this.log(
            (this.language === 'zh-CN' ? '请在本机浏览器打开：' : 'Open on this computer: ') + url.href,
          );
        if (this.manual) manualLink();
        else {
          this.log(
            this.language === 'zh-CN'
              ? '正在打开 3DR 网站，请在浏览器中确认授权。'
              : 'Opening the 3DR website. Approve this device in your browser.',
          );
          Promise.resolve()
            .then(() => this.open(url.href))
            .catch(manualLink);
        }
      });
    } finally {
      server.close();
      server.closeIdleConnections();
    }
  }
  async connect() {
    return this.vault.locked(async () => {
      const saved = await this.vault.read();
      if (saved) {
        try {
          return await this.exchange({ grant_type: 'refresh_token', refresh_token: saved.refresh });
        } catch (error) {
          if (!error.invalidGrant) throw error;
          await this.vault.clear();
        }
      }
      return this.login();
    });
  }
  async token(rejected) {
    return this.vault.locked(async () => {
      const saved = await this.vault.read();
      if (!saved) {
        if (this.autoLogin && !rejected && !(await this.vault.autoLoginBlocked?.())) return this.login();
        const error = new Error(
          this.language === 'zh-CN'
            ? '请先运行 3dr login。'
            : 'Sign in with 3dr login.',
        );
        error.loginRequired = true;
        throw error;
      }
      if (saved.expires > Date.now() + 30000 && saved.access !== rejected) return saved.access;
      try {
        return await this.exchange({ grant_type: 'refresh_token', refresh_token: saved.refresh });
      } catch (error) {
        if (error.invalidGrant) await this.vault.clear();
        throw error;
      }
    });
  }
  async logout() {
    return this.vault.locked(async () => {
      const saved = await this.vault.read();
      if (!saved) return;
      const meta = await this.metadata();
      const res = await this.fetcher(meta.revocation_endpoint, {
        method: 'POST',
        body: new URLSearchParams({ client_id: clientId, token: saved.refresh }),
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error('Revocation failed. You can revoke this connection on the website.');
      await this.vault.clear();
    });
  }
  async request(url, options) {
    if (new URL(url).origin !== this.endpoint.origin) throw new Error('Invalid resource origin.');
    const send = (token) => {
      const headers = new Headers(options.headers);
      headers.set('authorization', 'Bearer ' + token);
      return this.fetcher(url, { ...options, headers, redirect: 'error' });
    };
    const token = await this.token();
    let res = await send(token);
    if (res.status === 401) {
      await res.body?.cancel();
      res = await send(await this.token(token));
    }
    return res;
  }
}
