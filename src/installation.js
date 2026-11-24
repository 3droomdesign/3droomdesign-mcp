import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import lockfile from 'proper-lockfile';

const skill = '3dr-media-design';
const source = new URL('../skills/3dr-media-design/SKILL.md', import.meta.url);
const digest = (content) => createHash('sha256').update(content).digest('hex');
const marker = /\n<!-- 3dr-media-mcp:([a-f0-9]{64}) -->\n$/;

export const agentNames = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  opencode: 'OpenCode',
};

export function locations(base = homedir(), env = process.env) {
  return {
    preferences: join(base, '.3dr-media-mcp'),
    codex: join(base, '.agents', 'skills'),
    'claude-code': join(env.CLAUDE_CONFIG_DIR || join(base, '.claude'), 'skills'),
    cursor: join(base, '.cursor', 'skills'),
    opencode: join(env.XDG_CONFIG_HOME || join(base, '.config'), 'opencode', 'skills'),
  };
}

const copy = {
  en: {
    choose: 'Choose a language / 选择语言',
    agents: 'Install the 3DR skill for which local agents?',
    hint: 'Enter numbers or names separated by commas (e.g. 1,3), or 0 to skip.',
    discovery: 'Some agents also discover skills in shared directories.',
    invalid: 'Choose one of the listed options.',
    cancelled: 'Setup cancelled.',
    flags:
      'For unattended setup, pass --agents codex,claude-code,cursor,opencode (choose your targets), or --agents none.',
    conflict:
      'An existing or edited skill needs your review. Move it aside to install the packaged version:',
    installed: 'Installed',
    current: 'Already up to date',
    ready: 'Setup complete.',
    next: (cli) => `Run ${cli} login to authorize this computer. Then open a new agent session.`,
    deps: (cli) =>
      `The CLI must be on the agent’s PATH. Run ${cli} config to print a ready-to-copy local MCP entry.`,
  },
  'zh-CN': {
    choose: '选择语言 / Choose a language',
    agents: '将 3DR skill 安装到哪些本地 Agent？',
    hint: '输入编号或名称，用逗号分隔（如 1,3），输入 0 跳过。',
    discovery: '部分 Agent 也会读取共享目录中的 skill。',
    invalid: '请从列出的选项中选择。',
    cancelled: '已取消安装设置。',
    flags:
      '无人值守安装请用 --agents 指定所需的 codex、claude-code、cursor、opencode，或用 --agents none 跳过。',
    conflict: '此位置已有其他文件或经修改的 skill，请先检查并移开后再安装：',
    installed: '已安装',
    current: '已是当前版本',
    ready: '设置完成。',
    next: (cli) => `运行 ${cli} login 在网站授权这台电脑，然后打开新的 Agent 会话。`,
    deps: (cli) => `Agent 需要能从 PATH 找到 CLI。运行 ${cli} config 可复制本机的 MCP 宿主配置。`,
  },
};
export function matchesLanguage(value) {
  if (!value) return;
  if (/^(?:zh(?:-cn)?|中文|1)$/i.test(value)) return 'zh-CN';
  if (/^(?:en|english|2)$/i.test(value)) return 'en';
}

export async function preferredLanguage(paths, env = process.env) {
  try {
    const saved = matchesLanguage((await readFile(join(paths.preferences, 'language'), 'utf8')).trim());
    if (saved) return saved;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return /^(?:zh|chinese)/i.test(env.LC_ALL || env.LC_MESSAGES || env.LANG || '') ? 'zh-CN' : 'en';
}

export function selectedAgents(value) {
  const items = value
    .toLowerCase()
    .trim()
    .split(/[,，\s]+/)
    .filter(Boolean);
  if (items.length === 1 && ['0', 'none'].includes(items[0])) return [];
  const ids = Object.keys(agentNames);
  const selections = items.map((item) => (/^[1-4]$/.test(item) ? ids[Number(item) - 1] : item));
  if (!selections.length || !selections.every((item) => ids.includes(item))) return;
  return [...new Set(selections)];
}

async function existing(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function atomicWrite(path, contents, exclusive = false) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
    if (exclusive) await link(temporary, path);
    else await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function plan(path, content, text) {
  const folder = await existing(dirname(path));
  if (folder && !folder.isDirectory()) throw new Error(text.conflict + ' ' + dirname(path));
  const file = await existing(path);
  if (!file) return 'new';
  if (file.isFile()) {
    const previous = await readFile(path, 'utf8');
    if (previous === content) return 'current';
    const signed = marker.exec(previous);
    if (signed && digest(previous.slice(0, signed.index)) === signed[1]) return 'update';
  }
  throw new Error(text.conflict + ' ' + path);
}

export async function installSkills(ids, language, paths) {
  const text = copy[language];
  const body = await readFile(source, 'utf8');
  const content = body + '\n<!-- 3dr-media-mcp:' + digest(body) + ' -->\n';
  await mkdir(paths.preferences, { recursive: true, mode: 0o700 });
  const unlock = await lockfile.lock(paths.preferences, { retries: { retries: 8, minTimeout: 75 } });
  try {
    const entries = [];
    for (const id of ids) {
      const path = join(paths[id], skill, 'SKILL.md');
      entries.push({ id, path, action: await plan(path, content, text) });
    }
    const installedFolders = new Set();
    for (const entry of entries) {
      if (entry.action === 'current') continue;
      await mkdir(dirname(entry.path), { recursive: true, mode: 0o700 });
      const folder = await realpath(dirname(entry.path));
      // Multiple hosts can symlink their skills directories to the same location.
      if (installedFolders.has(folder)) {
        entry.action = 'current';
        continue;
      }
      await atomicWrite(entry.path, content, entry.action === 'new');
      installedFolders.add(folder);
    }
    await atomicWrite(join(paths.preferences, 'language'), language + '\n');
    return entries;
  } finally {
    await unlock();
  }
}

export async function setup({
  language, explicitLanguage, agents, paths, input, output, interactive, cli = '3dr',
}) {
  const line = (s) => output.write(s + '\n');
  const reader = interactive ? createInterface({ input, output, terminal: !!input.isTTY }) : null;
  const lines = reader?.[Symbol.asyncIterator]();
  async function choose(prompt, parse) {
    for (;;) {
      output.write(prompt + ' ');
      const reply = await lines.next();
      if (reply.done) throw new Error(copy[language].cancelled);
      const result = parse(reply.value.trim());
      if (result !== undefined) return result;
      line(copy[language].invalid);
    }
  }
  try {
    if (interactive && !explicitLanguage) {
      line(copy[language].choose);
      language = await choose('1. 简体中文  2. English [' + language + ']', (s) =>
        s ? matchesLanguage(s) : language,
      );
    }
    const t = copy[language];
    let ids;
    if (agents !== undefined) {
      ids = selectedAgents(agents);
      if (!ids) throw new Error(t.flags);
    } else {
      if (!interactive) throw new Error(t.flags);
      line(t.agents);
      Object.entries(agentNames).forEach(([id, name], i) =>
        line('  ' + (i + 1) + '. ' + name + '  ' + paths[id]),
      );
      line(t.discovery);
      ids = await choose(t.hint, selectedAgents);
    }
    const entries = await installSkills(ids, language, paths);
    for (const entry of entries)
      line(
        (entry.action === 'current' ? t.current : t.installed) +
          ' · ' +
          agentNames[entry.id] +
          ' · ' +
          entry.path,
      );
    line(t.ready + ' ' + t.next(cli));
    if (!ids.length) line(t.deps(cli));
  } finally {
    reader?.close();
  }
}
