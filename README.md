# 3D Room Design MCP

Use your own 3D Room Design account from a local agent to create interior images, architectural renders, floor-plan previews and design videos. The CLI includes an Agent Skill and an MCP stdio server. Node.js 22+ is required.

## Install and connect / 安装与授权

Install `3dr` directly from GitHub in any terminal with Node.js 22+, npm and Git. 安装好 Node.js 22 或更高版本、npm 和 Git 后，在任意目录打开终端即可安装。

```sh
npm install --global git+https://github.com/3droomdesign/3droomdesign-mcp.git
3dr --version
3dr setup
3dr login
```

在安装向导中选择简体中文或 English，然后选择一个或多个本地 Agent。运行 `login` 会打开系统浏览器，在已有的 3DR 账号下确认设备、工具权限与积分限额。回到终端后打开新的 Agent 会话即可。例如可以说「将这张客厅照片分别改成浅橡木和暖灰风格，先给我报价」。用户可随时在站点「账户 → MCP 连接」撤销对应设备。

The setup wizard installs the **3dr-media-design** skill only in the selected destinations. Supported user-level locations are Codex (`~/.agents/skills`), Claude Code (`~/.claude/skills`), Cursor (`~/.cursor/skills`) and OpenCode (`~/.config/opencode/skills`). Some hosts also scan shared or compatible skill directories. Choosing a destination controls where the installer writes. Use a separate profile and website grant when you need separate access or spending limits. A rerun updates previously installed skills and preserves locally edited copies. Open a new agent session after installing.

```sh
3dr setup --lang zh-CN --agents codex,claude-code
3dr skills install --lang en --agents cursor,opencode
3dr setup --lang en --agents none
3dr --profile studio login
3dr --profile studio status
```

Keep the executable on the agent’s PATH. Hosts that support a terminal can run the skill immediately. For a host using the MCP protocol, register the following local process. For example, Codex supports `codex mcp add 3dr -- 3dr serve`. Run `3dr config` for a ready-to-copy JSON entry with absolute Node and script paths, including on Windows or when your GUI host has a different PATH.

```json
{"mcpServers":{"3dr":{"command":"3dr","args":["serve"]}}}
```

When connecting to a test deployment, set `THREEDR_SITE_ORIGIN` to its website origin in your terminal before login. Run `3dr --profile runtime-qa config` in that same terminal. Paste the resulting entry into your desktop host to use the same website and profile after a restart. The entry contains executable paths, the selected profile and the site address. Your credential stays in the operating system’s credential store.

## Tools and user data

```sh
3dr tools
3dr call list_design_presets
3dr upload ./room.png
3dr call list_selected_assets --json '{"limit":5}'
3dr call quote_tool --json '{"tool":"generate_floor_plan_image","arguments":{"brief":"Two bedrooms and an open kitchen"}}'
3dr download ASSET_REF ./result.png
```

Use `call TOOL --json -` to read an argument object from stdin. Successful data commands print JSON. Each connection sees its granted tools, selected site images and its own results. Discover available presets at runtime. Use a single `request_id` for a logical generation and its retries. If a run requires confirmation, open its approval link on the website, then use `get_run` with its `run_id`. The bundled [skill](skills/3dr-media-design/SKILL.md) also covers variants, video, tours and CAD.

`login` uses the browser, authorization code with PKCE, and a temporary loopback callback. Use `login --no-browser` to open the printed link on the same computer. Tokens are saved in the operating system's credential store (macOS Keychain, Windows Credential Manager or an unlocked Linux Secret Service). Use `status` to check live access and `logout` to revoke it. A website revocation applies to subsequent requests. Each site and profile has its own credential. Requests go to the website’s MCP endpoint. Uploads send the selected file to a single-use signed destination.

## Distribution

The executable and bundled Agent Skill are licensed for use with your 3D Room Design account. See [LICENSE](LICENSE).
