#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import manifest from '../package.json' with { type: 'json' };
import { deviceVault, Session, siteEndpoint, validateProfile } from '../src/auth.js';
import { Bridge, serve } from '../src/bridge.js';
import { downloadFile, uploadFile } from '../src/files.js';
import { locations, matchesLanguage, preferredLanguage, setup } from '../src/installation.js';
import { remindAboutUpdate, updateCli } from '../src/update.js';

const help = {
  en: `3D Room Design MCP · Node.js 22+
Usage: 3dr [options] <command>
  setup [--lang en|zh-CN] [--agents codex,cursor]   Choose language and skill destinations
  skills install [--agents ...]                    Add or update the skill for selected agents
  update [--check]                                 Install a newer GitHub version, or only check
  login [--no-browser]                             Authorize this computer on the 3DR website
  status | logout                                  Check site access or revoke the connection
  tools                                            List granted tools and their input schemas
  call TOOL [--json OBJECT|-]                      Call a tool with JSON arguments or stdin
  upload FILE | download ASSET_REF FILE             Transfer the selected file
  config                                           Print a stdio host entry with local executable paths
  serve                                            Run the local MCP server over stdio
  --profile NAME                                   Use a separate authorization
  Supported agents: codex, claude-code, cursor, opencode. Use --agents none to skip.
`,
  'zh-CN': `3D Room Design MCP · Node.js 22+
用法：3dr [选项] <命令>
  setup [--lang zh-CN|en] [--agents codex,cursor]   选择语言和 skill 安装位置
  skills install [--agents ...]                    为选中的 Agent 安装或更新 skill
  update [--check]                                 从 GitHub 更新版本，加 --check 仅检查
  login [--no-browser]                             打开 3DR 网站，授权这台电脑
  status | logout                                  查看连接状态，或撤销连接
  tools                                            列出已授权的工具及其参数
  call TOOL [--json OBJECT|-]                      用 JSON 参数或标准输入调用工具
  upload FILE | download ASSET_REF FILE             上传指定图片或下载结果
  config                                           输出含本机可执行文件路径的 MCP 配置
  serve                                            通过 stdio 运行本地 MCP 服务
  --profile NAME                                   使用一份独立授权
  支持 codex、claude-code、cursor、opencode。用 --agents none 跳过安装 skill。
`,
};
const jsonOut = (value) => process.stdout.write(JSON.stringify(value) + '\n');
async function argumentsFor(value) {
  if (value === undefined) return {};
  if (value === '-') {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 1048576) throw new Error('JSON input exceeds 1 MiB.');
      chunks.push(chunk);
    }
    value = Buffer.concat(chunks).toString('utf8');
  }
  const args = JSON.parse(value);
  if (args === null || Array.isArray(args) || typeof args !== 'object')
    throw new Error('Expected a JSON object.');
  return args;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      endpoint: { type: 'string' }, // Compatibility with already installed v0.2 hosts.
      profile: { type: 'string', default: 'default' },
      lang: { type: 'string' },
      agents: { type: 'string', multiple: true },
      check: { type: 'boolean' },
      json: { type: 'string' },
      'no-browser': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (values.version) {
    process.stdout.write(manifest.version + '\n');
    return;
  }
  const profile = validateProfile(values.profile);
  const paths = locations();
  const language =
    values.lang === undefined ? await preferredLanguage(paths) : matchesLanguage(values.lang);
  if (!language) throw new Error('Choose --lang zh-CN or --lang en.');
  if (values.help) {
    process.stdout.write(help[language]);
    return;
  }
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const [command = interactive ? 'setup' : 'serve', ...args] = positionals;
  const installer =
    (command === 'setup' && !args.length) || (command === 'skills' && args.join(' ') === 'install');
  const invalid = () => {
    throw new Error(
      language === 'zh-CN' ? '参数无效，请查看 --help。' : 'Invalid arguments. See --help.',
    );
  };
  if (command === 'update') {
    if (args.length || values.agents !== undefined || values.json !== undefined) return invalid();
    const report = await updateCli({
      directory: fileURLToPath(new URL('../', import.meta.url)),
      preferences: paths.preferences,
      checkOnly: values.check,
    });
    return jsonOut(report);
  }
  if (values.check) return invalid();
  const profileArgs = [];
  if (profile !== 'default') {
    if (profile.startsWith('-')) profileArgs.push('--profile=' + profile);
    else profileArgs.push('--profile', profile);
  }
  const cli = ['3dr', ...profileArgs].join(' ');
  const checkForNotice = command === 'status' || (interactive && (installer || ['login', 'tools'].includes(command)));
  if (!process.env.CI && checkForNotice)
    await remindAboutUpdate({
      current: manifest.version,
      preferences: paths.preferences,
      language,
      write: (message) => process.stderr.write(message),
    });
  if (installer) {
    if (values.json !== undefined) return invalid();
    await setup({
      cli,
      language,
      explicitLanguage: values.lang !== undefined,
      agents: values.agents?.join(','),
      paths,
      input: process.stdin,
      output: process.stdout,
      interactive,
    });
    return;
  }
  if (values.agents !== undefined || (values.json !== undefined && command !== 'call')) return invalid();
  const endpoint = siteEndpoint(undefined, values.endpoint);
  const vault = deviceVault(endpoint, profile);
  if (command === 'config' && !args.length) {
    const serverArgs = [fileURLToPath(import.meta.url), 'serve', ...profileArgs];
    const server = { command: process.execPath, args: serverArgs };
    if (process.env.THREEDR_SITE_ORIGIN) server.env = { THREEDR_SITE_ORIGIN: endpoint.origin };
    return jsonOut({ mcpServers: { '3dr': server } });
  }
  const session = new Session(endpoint, vault, {
    language,
    loginCommand: cli + ' login',
    autoLogin: command === 'serve',
    manual: values['no-browser'],
  });
  const bridge = new Bridge(session);
  if (command === 'serve' && !args.length) return serve(bridge);
  if (command === 'login' && !args.length) {
    await session.connect();
    process.stderr.write(
      language === 'zh-CN'
        ? '已授权，可通过站点账户页管理此连接。\n'
        : 'Connected. Manage this device on the 3DR account page.\n',
    );
  } else if (command === 'status' && !args.length) {
    try {
      await bridge.remote('tools/list');
      jsonOut({ connected: true, profile });
    } catch (error) {
      if (!error.loginRequired && !error.invalidGrant) throw error;
      jsonOut({ connected: false, profile });
      process.exitCode = 1;
    }
  } else if (command === 'logout' && !args.length) {
    await session.logout();
    process.stderr.write(language === 'zh-CN' ? '本机连接已移除。\n' : 'Connection removed.\n');
  } else if (command === 'tools' && !args.length) jsonOut(await bridge.remote('tools/list'));
  else if (command === 'call' && args.length === 1)
    jsonOut(await bridge.call(args[0], await argumentsFor(values.json)));
  else if (command === 'upload' && args.length === 1) jsonOut(await uploadFile(bridge, args[0]));
  else if (command === 'download' && args.length === 2)
    jsonOut(await downloadFile(bridge, args[0], args[1]));
  else invalid();
}
try {
  await main();
} catch (error) {
  process.stderr.write('3DR MCP: ' + error.message + '\n');
  process.exitCode = 1;
}
