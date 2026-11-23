import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import lockfile from 'proper-lockfile';
import semver from 'semver';

const repo = '3droomdesign/3droomdesign-mcp';
const packageName = '3droomdesign-mcp';
const gitSource = 'git+https://github.com/' + repo + '.git';
const day = 24 * 60 * 60 * 1000;

function packageVersion(data) {
  const version = semver.valid(data?.version);
  if (data?.name !== packageName || !version) throw new Error('Invalid 3dr package version.');
  return version;
}

export async function latestRelease(signal = AbortSignal.timeout(10000), request = fetch) {
  const head = await request('https://api.github.com/repos/' + repo + '/commits/main', {
    headers: { Accept: 'application/vnd.github.sha', 'User-Agent': packageName },
    signal,
  });
  if (!head.ok) throw new Error('GitHub update check returned HTTP ' + head.status + '.');
  const revision = (await head.text()).trim();
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('Invalid GitHub revision.');
  const file = await request(
    'https://raw.githubusercontent.com/' + repo + '/' + revision + '/package.json',
    { signal },
  );
  if (!file.ok) throw new Error('GitHub version lookup returned HTTP ' + file.status + '.');
  return { version: packageVersion(await file.json()), revision };
}

async function withUpdateLock(preferences, action) {
  await mkdir(preferences, { recursive: true, mode: 0o700 });
  const unlock = await lockfile.lock(preferences, {
    lockfilePath: join(preferences, 'cli-update.lock'),
  });
  try {
    return await action();
  } finally {
    await unlock();
  }
}

export async function installFromGitHub(directory, revision, run = promisify(execFile)) {
  const modules = dirname(directory);
  const parent = dirname(modules);
  const windows = process.platform === 'win32';
  const prefix = windows ? parent : dirname(parent);
  const layout =
    basename(directory) === packageName &&
    basename(modules) === 'node_modules' &&
    (windows || basename(parent) === 'lib');
  const shim = windows ? join(prefix, '3dr.cmd') : join(prefix, 'bin', '3dr');
  const registered =
    layout &&
    (windows
      ? existsSync(shim)
      : (await realpath(shim).catch(() => '')) === (await realpath(join(directory, 'bin', '3dr.js'))));
  if (!registered)
    throw new Error(
      'This copy is outside a global npm installation. Install with npm install --global ' + gitSource,
    );

  const args = [
    'install',
    '--global',
    '--prefix',
    prefix,
    '--engine-strict',
    '--no-audit',
    '--no-fund',
    gitSource + '#' + revision,
  ];
  if (windows) {
    const locations = [
      dirname(process.execPath),
      ...(process.env.PATH || '').split(delimiter).filter(Boolean),
    ];
    const npm = locations
      .map((dir) => join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
      .find(existsSync);
    if (!npm) throw new Error('npm is required to update 3dr.');
    await run(process.execPath, [npm, ...args], { windowsHide: true });
  } else {
    await run('npm', args);
  }
}

export async function updateCli({
  directory,
  preferences,
  checkOnly,
  lookup = latestRelease,
  install = installFromGitHub,
}) {
  directory = await realpath(directory);
  const installedVersion = async () =>
    packageVersion(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')));
  const { version: latest, revision } = await lookup();
  const report = (current) => {
    const updateAvailable = semver.gt(latest, current);
    return { current, latest, updateAvailable, ...(updateAvailable && { command: '3dr update' }) };
  };
  const initial = report(await installedVersion());
  if (checkOnly || !initial.updateAvailable) return initial;

  return withUpdateLock(preferences, async () => {
    const before = report(await installedVersion());
    if (!before.updateAvailable) return before;
    await install(directory, revision);
    const installed = await installedVersion();
    if (installed !== latest)
      throw new Error('npm finished but the installed 3dr version does not match ' + latest + '.');
    return { ...report(installed), previous: before.current, updated: true };
  });
}

export async function remindAboutUpdate({
  current,
  preferences,
  language,
  write,
  lookup = latestRelease,
}) {
  try {
    const due = await withUpdateLock(preferences, async () => {
      const marker = join(preferences, 'last-update-check');
      const last = await stat(marker).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (last && Math.abs(Date.now() - last.mtimeMs) < day) return false;
      await writeFile(marker, '', { mode: 0o600 });
      return true;
    });
    if (!due) return;
    const { version } = await lookup(AbortSignal.timeout(2500));
    if (semver.gt(version, current))
      write(
        language === 'zh-CN'
          ? `3dr ${version} 可用（当前 ${current}）。运行 3dr update 更新。\n`
          : `3dr ${version} is available (installed ${current}). Run 3dr update to install it.\n`,
      );
  } catch {
    // A reminder is optional. Explicit update checks surface network and installation errors.
  }
}
