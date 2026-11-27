import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { deviceLogin } from './device-auth.js';

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
export function validateProfile(profile) {
  if (typeof profile !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(profile))
    throw new Error('Invalid local profile name.');
  return profile;
}
export function deviceVault(endpoint, profile) {
  validateProfile(profile);
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
      let value;
      try {
        value = await (await credential()).getPassword();
      } catch (cause) {
        if (process.platform !== 'linux') throw cause;
        throw new Error(
          'Could not read the operating system credential store. Unlock a Linux Secret Service in the session running 3dr.',
          { cause },
        );
      }
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
        // Another host may be waiting for a ten-minute device authorization.
        retries: { retries: 650, factor: 1, minTimeout: 1000, maxTimeout: 1000 },
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
      loginMode = 'auto',
      autoLogin = true,
      language = 'en',
      loginCommand = '3dr login',
    } = {},
  ) {
    this.endpoint = endpoint;
    this.vault = vault;
    this.open = open;
    this.log = log;
    this.fetcher = fetcher;
    this.manual = manual;
    this.loginMode = loginMode;
    this.autoLogin = autoLogin;
    this.language = language;
    this.loginCommand = loginCommand;
  }
  async metadata() {
    if (this.metadataCache) return this.metadataCache;
    const read = async (path) => {
      const url = new URL(path, this.endpoint);
      const zh = this.language === 'zh-CN';
      let response;
      try {
        response = await this.fetcher(url, {
          headers: { accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
        });
      } catch (cause) {
        throw new Error(
          zh
            ? `无法获取站点的 MCP OAuth 元数据，请检查网络和站点地址。 ${url.href}`
            : `Could not fetch MCP OAuth metadata. Check the network and site address. ${url.href}`,
          { cause },
        );
      }
      const source = `${url.href} (HTTP ${response.status})`;
      if (!response.ok && response.status !== 404) {
        let message = zh ? '读取 MCP OAuth 元数据失败。' : 'Could not read MCP OAuth metadata.';
        if (response.status === 401 || response.status === 403)
          message = zh
            ? '站点限制了对 MCP OAuth 元数据的访问。'
            : 'The site restricted access to its MCP OAuth metadata.';
        else if (response.status === 429 || response.status >= 500)
          message = zh
            ? '暂时无法读取 MCP OAuth 元数据，请稍后再试。'
            : 'MCP OAuth metadata is temporarily unavailable. Try again later.';
        throw new Error(`${message} ${source}`);
      }
      if (response.ok) {
        const body = await response.text();
        const html = /^text\/html\b/i.test(response.headers.get('content-type') || '') ||
          /^\s*<(?:!doctype\s+html|html|head|body)\b/i.test(body);
        if (!html) {
          let metadata;
          try {
            metadata = JSON.parse(body);
          } catch {
            // An invalid document is distinct from a missing route or a frontend fallback.
          }
          if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) return metadata;
          throw new Error(
            zh ? `MCP OAuth 元数据格式无效。 ${source}` : `Invalid MCP OAuth metadata document. ${source}`,
          );
        }
      }
      throw new Error(
        zh
          ? `该站点未提供 MCP OAuth 元数据。 ${source}。如使用测试站，请从该测试站账户的 MCP 连接页复制接入命令。`
          : `The site did not provide MCP OAuth metadata. ${source}. For a test site, copy the setup command from that site's Account → MCP connections page.`,
      );
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
    const endpoints = ['authorization_endpoint', 'token_endpoint', 'revocation_endpoint'];
    if (meta.device_authorization_endpoint !== undefined) endpoints.push('device_authorization_endpoint');
    for (const key of endpoints) {
      const u = new URL(meta[key]);
      if (
        u.protocol !== this.endpoint.protocol ||
        u.origin !== meta.issuer ||
        u.username ||
        u.password ||
        u.hash
      )
        throw new Error('Invalid OAuth endpoint.');
    }
    this.metadataCache = meta;
    return meta;
  }
  async exchange(parameters, timeout = 30000) {
    const meta = await this.metadata();
    const res = await this.fetcher(meta.token_endpoint, {
      method: 'POST',
      body: new URLSearchParams({ client_id: clientId, resource: this.endpoint.href, ...parameters }),
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) {
      const problem = await res.json().catch(() => ({}));
      const error = new Error(
        problem.error === 'invalid_grant'
          ? this.language === 'zh-CN'
            ? `授权已到期或被撤销，请运行 ${this.loginCommand}。`
            : `Authorization expired or revoked. Run ${this.loginCommand}.`
          : 'The token request failed (' + res.status + ').',
      );
      error.oauthCode = problem.error;
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
    if (meta.device_authorization_endpoint && this.loginMode !== 'loopback')
      return deviceLogin(this, meta, {
        client_id: clientId,
        resource: this.endpoint.href,
        scope: supportedScopes(meta),
      });
    if (this.loginMode === 'device')
      throw new Error(
        this.language === 'zh-CN'
          ? '此站点尚未提供设备码登录。请在运行 3dr 的电脑上使用本机回调登录。'
          : 'This site does not offer device login yet. Use loopback login on the computer running 3dr.',
      );
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
                  ? `授权超时，请重新运行 ${this.loginCommand}。`
                  : `Authorization timed out. Run ${this.loginCommand} again.`,
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
            if (callback.searchParams.get('error') === 'access_denied') {
              await this.vault.clear();
              throw new Error(this.language === 'zh-CN' ? '授权已拒绝。' : 'Authorization declined.');
            }
            if (callback.searchParams.has('error') || !callback.searchParams.get('code'))
              throw new Error(
                this.language === 'zh-CN'
                  ? `授权未完成，请重新运行 ${this.loginCommand}。`
                  : `Authorization did not complete. Run ${this.loginCommand} again.`,
              );
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
            ? `请先运行 ${this.loginCommand}。`
            : `Sign in with ${this.loginCommand}.`,
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
      if (!saved) return this.vault.clear();
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
