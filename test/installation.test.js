import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  installSkills,
  locations,
  preferredLanguage,
  selectedAgents,
  setup,
} from '../src/installation.js';
import { siteEndpoint } from '../src/auth.js';

async function sandbox(t) {
  const base = await mkdtemp(join(tmpdir(), '3dr-install-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const paths = locations(base, {});
  const file = (id) => join(paths[id], '3dr-media-design', 'SKILL.md');
  return { paths, file, base };
}
function terminal(data = []) {
  const notes = [];
  const output = new Writable({
    write(chunk, _, cb) {
      notes.push(String(chunk));
      cb();
    },
  });
  return { input: Readable.from(data), output, notes };
}

test('two-language wizard installs only selected destinations and remembers the language', async (t) => {
  const { paths, file } = await sandbox(t);
  const term = terminal(['1\nunknown\n1,3\n']);
  await setup({ paths, language: 'en', interactive: true, ...term });
  assert.match(term.notes.join(''), /安装到哪些本地 Agent/);
  assert.match(term.notes.join(''), /请从列出的选项/);
  assert.equal(await preferredLanguage(paths, { LANG: 'en' }), 'zh-CN');
  for (const id of ['codex', 'cursor'])
    assert.match(await readFile(file(id), 'utf8'), /name: 3dr-media-design/);
  for (const id of ['claude-code', 'opencode'])
    await assert.rejects(stat(paths[id]), { code: 'ENOENT' });
  assert.deepEqual(selectedAgents('2，4,claude-code'), ['claude-code', 'opencode']);
});

test('noninteractive selection, repeat installs, managed upgrades and user edits', async (t) => {
  const { paths, file } = await sandbox(t);
  const invocation = { ...terminal(), paths, language: 'en', interactive: false };
  await assert.rejects(setup(invocation), /--agents/);
  await assert.rejects(setup({ ...invocation, agents: 'cursor,invalid' }), /--agents/);
  await setup({ ...invocation, agents: 'none' });
  await assert.rejects(stat(paths.cursor), { code: 'ENOENT' });
  const ids = ['claude-code', 'opencode'];
  await setup({ ...invocation, agents: ids.join(',') });
  const original = await readFile(file(ids[0]), 'utf8');
  assert.deepEqual(
    (await installSkills(ids, 'en', paths)).map((x) => x.action),
    ['current', 'current'],
  );
  const old = 'previous release\n';
  await writeFile(
    file(ids[0]),
    old + '\n<!-- 3dr-media-mcp:' + createHash('sha256').update(old).digest('hex') + ' -->\n',
  );
  assert.equal((await installSkills(ids, 'en', paths))[0].action, 'update');
  assert.equal(await readFile(file(ids[0]), 'utf8'), original);
  await writeFile(file(ids[0]), original.replace('3DR media design', 'my own notes'));
  await assert.rejects(installSkills(['cursor', ...ids], 'en', paths), /review/);
  await assert.rejects(stat(paths.cursor), { code: 'ENOENT' });
  assert.match(await readFile(file(ids[0]), 'utf8'), /my own notes/);
  await rm(file(ids[0]));
  await symlink(file(ids[1]), file(ids[0]));
  await assert.rejects(installSkills(ids, 'en', paths), /review/);
  assert.equal(await readFile(file(ids[1]), 'utf8'), original);
});

test('unattended or cancelled setup cannot silently install to all hosts', async (t) => {
  const { paths } = await sandbox(t);
  await assert.rejects(setup({ ...terminal(), paths, language: 'en', interactive: true }), /cancelled/);
  await assert.rejects(stat(paths.preferences), { code: 'ENOENT' });
  assert.deepEqual(selectedAgents('0'), []);
  assert.equal(selectedAgents('codex,none'), undefined);
});

test('a shared skills directory installs once for multiple selected agents and preserves edits', async (t) => {
  const { paths, file } = await sandbox(t);
  await mkdir(paths.codex, { recursive: true });
  await mkdir(dirname(paths.cursor), { recursive: true });
  await symlink(paths.codex, paths.cursor, 'junction');
  const targets = ['codex', 'cursor'];
  const first = await installSkills(targets, 'zh-CN', paths);
  assert.deepEqual(first.map((entry) => entry.action), ['new', 'current']);
  assert.equal(await preferredLanguage(paths), 'zh-CN');
  assert.equal(await readFile(file('cursor'), 'utf8'), await readFile(file('codex'), 'utf8'));
  const second = await installSkills(targets, 'en', paths);
  assert.deepEqual(second.map((entry) => entry.action), ['current', 'current']);
  await writeFile(file('cursor'), 'local edits');
  await assert.rejects(installSkills(targets, 'en', paths), /edited skill/);
  assert.equal(await readFile(file('codex'), 'utf8'), 'local edits');
});

test('setup guides the next login and host configuration to the selected profile', async (t) => {
  const { base, paths } = await sandbox(t);
  const bin = fileURLToPath(new URL('../bin/3dr.js', import.meta.url));
  const env = { ...process.env, HOME: base, USERPROFILE: base, CI: '1' };
  const run = (...args) => spawnSync(process.execPath, [bin, ...args], { env, encoding: 'utf8' });
  const setupArgs = ['setup', '--agents', 'none', '--lang'];
  assert.equal(run('--profile', 'invalid profile', ...setupArgs, 'en').status, 1);
  await assert.rejects(stat(paths.preferences), { code: 'ENOENT' });
  for (const language of ['en', 'zh-CN']) {
    const result = run('--profile', 'studio', ...setupArgs, language);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /3dr --profile studio login/);
    assert.match(result.stdout, /3dr --profile studio config/);
  }
  const dashed = run('--profile=-studio', ...setupArgs, 'en');
  assert.equal(dashed.status, 0, dashed.stderr);
  assert.match(dashed.stdout, /3dr --profile=-studio login/);
  const config = JSON.parse(run('--profile=-studio', 'config').stdout).mcpServers['3dr'];
  const child = spawnSync(config.command, config.args, { env, input: '', encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
});

test('only the process environment selects a website; legacy entries cannot change the audience', () => {
  assert.equal(siteEndpoint('').href, 'https://3droomdesign.ai/mcp');
  assert.equal(
    siteEndpoint('http://127.0.0.1:9000', 'https://3droomdesign.ai/mcp').href,
    'http://127.0.0.1:9000/mcp',
  );
  assert.equal(
    siteEndpoint('https://dev.example', 'https://dev.example/mcp').origin,
    'https://dev.example',
  );
  assert.throws(() => siteEndpoint('', 'https://old.example/mcp'), /different site/);
  assert.throws(() => siteEndpoint('https://dev.example', 'https://old.example/mcp'), /different site/);
  for (const value of [
    'http://untrusted.example',
    'https://example.org/api',
    'https://user@example.org',
    'https://example.org/?a=b',
  ])
    assert.throws(() => siteEndpoint(value));
});

test('config preserves the selected site and profile when a desktop host starts in a fresh environment', () => {
  const cli = fileURLToPath(new URL('../bin/3dr.js', import.meta.url));
  const env = { ...process.env };
  delete env.THREEDR_SITE_ORIGIN;
  function config(extra, args = []) {
    const json = execFileSync(process.execPath, [cli, ...args, 'config'], {
      env: { ...env, ...extra }, encoding: 'utf8',
    });
    return JSON.parse(json).mcpServers['3dr'];
  }
  assert.deepEqual(config({}), { command: process.execPath, args: [cli, 'serve'] });

  const origin = 'http://127.0.0.1:41234';
  const server = config(
    { THREEDR_SITE_ORIGIN: origin + '/', UNRELATED_VARIABLE: 'example' },
    ['--profile', 'runtime-qa'],
  );
  assert.deepEqual(server, {
    command: process.execPath,
    args: [cli, 'serve', '--profile', 'runtime-qa'],
    env: { THREEDR_SITE_ORIGIN: origin },
  });
  const handshake = {
    jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' },
  };
  const result = execFileSync(server.command, [...server.args, '--endpoint', origin + '/mcp'], {
    env: { ...env, ...server.env }, input: JSON.stringify(handshake) + '\n', encoding: 'utf8',
  });
  assert.equal(JSON.parse(result).result.serverInfo.name, '3droomdesign-mcp');

  for (const args of [['--profile', 'bad profile'], ['--endpoint', 'https://other.example/mcp']]) {
    assert.equal(spawnSync(process.execPath, [cli, ...args, 'config'], { env }).status, 1);
  }
  assert.equal(spawnSync(process.execPath, [cli, 'config'], {
    env: { ...env, THREEDR_SITE_ORIGIN: origin + '/path' },
  }).status, 1);
});
