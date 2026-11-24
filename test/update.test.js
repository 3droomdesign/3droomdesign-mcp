import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { installFromGitHub, latestRelease, remindAboutUpdate, updateCli } from '../src/update.js';

const run = promisify(execFile);
const name = '3droomdesign-mcp';
const official = 'git+https://github.com/3droomdesign/3droomdesign-mcp.git';
const exampleRevision = 'b'.repeat(40);
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), '3dr-updater-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, preferences: join(root, 'prefs') };
}

test('checks the official main commit and reads the package version at that same revision', async () => {
  const urls = [];
  const request = async (url) => {
    urls.push(url);
    return urls.length === 1
      ? new Response(exampleRevision)
      : Response.json({ name, version: '0.10.0' });
  };
  assert.deepEqual(await latestRelease(undefined, request), {
    version: '0.10.0',
    revision: exampleRevision,
  });
  assert.deepEqual(urls, [
    'https://api.github.com/repos/3droomdesign/3droomdesign-mcp/commits/main',
    'https://raw.githubusercontent.com/3droomdesign/3droomdesign-mcp/' +
      exampleRevision +
      '/package.json',
  ]);
  await assert.rejects(
    latestRelease(undefined, async () => new Response('', { status: 403 })),
    /403/,
  );
  await assert.rejects(
    latestRelease(undefined, async () => new Response('main')),
    /revision/,
  );
  await assert.rejects(
    latestRelease(undefined, async (url) =>
      url.includes('api.github.com')
        ? new Response(exampleRevision)
        : Response.json({ name: 'other', version: '12.0.0' }),
    ),
    /package/,
  );
});

test('read-only checks surface a new release and never downgrade a newer installation', async (t) => {
  const { root: directory, preferences } = await fixture(t);
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '0.9.0' }));
  const check = (latest, checkOnly) =>
    updateCli({
      directory,
      preferences,
      checkOnly,
      lookup: async () => ({ version: latest, revision: exampleRevision }),
      install: () => assert.fail('npm should not run'),
    });
  assert.deepEqual(await check('0.10.0', true), {
    current: '0.9.0',
    latest: '0.10.0',
    updateAvailable: true,
    command: '3dr update',
  });
  for (const version of ['0.8.9', '0.9.0', '0.9.0-rc.2']) {
    assert.deepEqual(await check(version, false), {
      current: '0.9.0',
      latest: version,
      updateAvailable: false,
    });
  }
  await assert.rejects(stat(preferences), { code: 'ENOENT' });
  await assert.rejects(
    updateCli({
      directory,
      preferences,
      lookup: async () => {
        throw Error('offline');
      },
    }),
    /offline/,
  );
});

test('a real npm upgrade replaces the registered global CLI in its own prefix and can be retried', async (t) => {
  const { root, preferences } = await fixture(t);
  const source = join(root, 'repo');
  const prefix = join(root, 'prefix with spaces');
  const directory =
    process.platform === 'win32'
      ? join(prefix, 'node_modules', name)
      : join(prefix, 'lib', 'node_modules', name);
  await mkdir(join(source, 'bin'), { recursive: true });
  await run('git', ['init', '--quiet', source]);
  const git = (...args) =>
    run(
      'git',
      [
        '-c',
        'user.name=3dr test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: source },
    );
  async function commitVersion(version) {
    await writeFile(
      join(source, 'package.json'),
      JSON.stringify({ name, version, bin: { '3dr': 'bin/3dr.js' } }),
    );
    await writeFile(
      join(source, 'bin', '3dr.js'),
      '#!/usr/bin/env node\nconsole.log("' + version + '")\n',
      { mode: 0o755 },
    );
    await git('add', 'package.json', 'bin/3dr.js');
    await git('commit', '-qm', version);
    return (await git('rev-parse', 'HEAD')).stdout.trim();
  }
  const previous = await commitVersion('0.3.4');
  const newer = await commitVersion('0.4.0');
  const gitFile = 'git+' + pathToFileURL(source).href + '#';
  const env = { ...process.env, npm_config_offline: 'true', npm_config_cache: join(root, 'npm-cache') };
  const seedArgs = [
    'install',
    '--global',
    '--prefix',
    prefix,
    '--no-audit',
    '--no-fund',
    gitFile + previous,
  ];
  if (process.env.npm_execpath)
    await run(process.execPath, [process.env.npm_execpath, ...seedArgs], { env });
  else await run('npm', seedArgs, { env });
  const lookup = async () => ({ version: '0.4.0', revision: newer });
  const options = { directory, preferences, lookup };
  await assert.rejects(
    updateCli({
      ...options,
      install: async () => {
        throw Error('npm failed');
      },
    }),
    /npm failed/,
  );
  const result = await updateCli({
    ...options,
    install: (dir, sha) =>
      installFromGitHub(dir, sha, async (program, args) => {
        assert.equal(args.at(-1), official + '#' + newer);
        assert.equal(args[args.indexOf('--prefix') + 1], prefix);
        // Replace only the package source with the fixture Git repository. Run the actual npm installer.
        return run(program, [...args.slice(0, -1), gitFile + sha], { env });
      }),
  });
  assert.deepEqual(result, {
    current: '0.4.0',
    latest: '0.4.0',
    updateAvailable: false,
    previous: '0.3.4',
    updated: true,
  });
  assert.equal((await run(process.execPath, [join(directory, 'bin', '3dr.js')])).stdout.trim(), '0.4.0');
  assert.equal((await updateCli(options)).updateAvailable, false);
  await assert.rejects(installFromGitHub(source, newer), /outside a global npm installation/);
});

test('reminders announce a newer version once per day, tolerate offline checks and retry the next day', async (t) => {
  const { preferences } = await fixture(t);
  let requests = 0;
  const lines = [];
  const options = {
    current: '0.3.4',
    preferences,
    language: 'zh-CN',
    write: (line) => lines.push(line),
  };
  const lookup = async () => {
    requests++;
    return { version: '0.4.0' };
  };
  await Promise.all([
    remindAboutUpdate({ ...options, lookup }),
    remindAboutUpdate({ ...options, lookup }),
  ]);
  await remindAboutUpdate({ ...options, lookup });
  assert.equal(requests, 1);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /0\.4\.0.*0\.3\.4.*3dr update/);
  const marker = join(preferences, 'last-update-check');
  await utimes(marker, 0, 0);
  await remindAboutUpdate({
    ...options,
    lookup: async () => {
      throw Error('offline');
    },
  });
  await remindAboutUpdate({ ...options, lookup });
  await utimes(marker, 0, 0);
  await remindAboutUpdate({ ...options, current: '0.4.1', lookup });
  assert.equal(requests, 2);
  assert.equal(lines.length, 1);
  assert.equal(await readFile(marker, 'utf8'), '');
});
