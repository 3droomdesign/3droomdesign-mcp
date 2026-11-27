const grantType = 'urn:ietf:params:oauth:grant-type:device_code';

export function hasLocalBrowser(env = process.env, platform = process.platform) {
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return false;
  return platform !== 'linux' || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

export async function deviceLogin(
  session,
  meta,
  parameters,
  wait = (ms) => new Promise((r) => setTimeout(r, ms)),
) {
  const zh = session.language === 'zh-CN';
  const response = await session.fetcher(meta.device_authorization_endpoint, {
    method: 'POST',
    body: new URLSearchParams(parameters),
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(
      zh
        ? `无法获取设备码 (HTTP ${response.status})。`
        : `Could not start device login (HTTP ${response.status}).`,
    );
  const {
    device_code,
    user_code,
    verification_uri,
    verification_uri_complete,
    expires_in,
    interval = 5,
  } = await response.json();
  if (
    typeof device_code !== 'string' ||
    !device_code ||
    typeof user_code !== 'string' ||
    !/^[A-Za-z0-9-]{4,32}$/.test(user_code) ||
    !Number.isSafeInteger(expires_in) ||
    expires_in <= 0 ||
    !Number.isSafeInteger(interval) ||
    interval <= 0
  )
    throw new Error('Invalid device authorization response.');

  const verification = new URL(verification_uri);
  if (
    verification.protocol !== session.endpoint.protocol ||
    verification.origin !== session.endpoint.origin ||
    verification.username ||
    verification.password ||
    verification.hash ||
    verification.search
  )
    throw new Error('Invalid device verification URL.');
  let browserUrl = verification;
  if (verification_uri_complete !== undefined) {
    const complete = new URL(verification_uri_complete);
    if (
      complete.protocol !== verification.protocol ||
      complete.origin !== verification.origin ||
      complete.pathname !== verification.pathname ||
      complete.username ||
      complete.password ||
      complete.hash ||
      complete.searchParams.size !== 1 ||
      complete.searchParams.get('user_code') !== user_code
    )
      throw new Error('Invalid device verification URL.');
    browserUrl = complete;
  }

  session.log(
    zh
      ? `在电脑或手机上打开 ${verification.href}，输入设备码 ${user_code}。请核对设备码并确认授权，保持此命令运行。`
      : `Open ${verification.href} on your computer or phone and enter ${user_code}. Check the code before approving and keep this command running.`,
  );
  if (!session.manual)
    void Promise.resolve()
      .then(() => session.open(browserUrl.href))
      .catch(() => {});

  const deadline = Date.now() + expires_in * 1000;
  let delay = interval * 1000;
  while (Date.now() < deadline) {
    await wait(Math.min(deadline - Date.now(), delay));
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      return await session.exchange({ grant_type: grantType, device_code }, Math.min(remaining, 30000));
    } catch (error) {
      if (error.oauthCode === 'authorization_pending') continue;
      if (error.oauthCode === 'slow_down') delay += 5000;
      else if (error.name === 'TimeoutError' || error.cause?.code === 'UND_ERR_CONNECT_TIMEOUT') delay *= 2;
      else if (error.oauthCode === 'expired_token') break;
      else if (error.oauthCode === 'access_denied') {
        await session.vault.clear();
        throw new Error(zh ? '授权已拒绝。' : 'Authorization declined.');
      } else throw error;
    }
  }
  throw new Error(
    zh
      ? `设备码已过期，请重新运行 ${session.loginCommand}。`
      : `Device code expired. Run ${session.loginCommand} again.`,
  );
}
