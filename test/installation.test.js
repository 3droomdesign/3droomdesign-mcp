import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
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
