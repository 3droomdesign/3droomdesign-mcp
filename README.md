# 3D Room Design MCP

Give your agent access to your 3D Room Design account to restyle a room photo, render an architectural sketch, preview a floor plan or make a design video. The `3dr` command includes an Agent Skill for terminal-capable agents and a local MCP server for stdio hosts.

## Install from your agent / 让 Agent 自行安装

把下面这句话发给能操作本机终端的 Agent 即可。

> 请从 https://github.com/3droomdesign/3droomdesign-mcp 为你当前所在的 Agent 安装 3dr 和对应的 Skill。按 README 的非交互步骤执行并检查连接。需要授权时请打开官网，我在浏览器里确认。

Agent 可以在本机终端完成安装、选择宿主和检查连接。首次连接时，你在浏览器里选择允许使用的工具和积分限额，授权后可在「账户 → MCP 连接」随时撤销。

**1. Install the CLI on the computer that runs the agent.** Check `node --version` (22 or newer), `npm --version` and `git --version`. Run the following from any directory. Use the same command to update an existing GitHub installation.

```sh
npm install --global git+https://github.com/3droomdesign/3droomdesign-mcp.git
3dr --version
```

**2. Run the one setup command for the host you are running in.** These commands work without a TTY. Use `--lang en` for English or `--lang zh-CN` for Simplified Chinese.

| Current host | Run this command |
| --- | --- |
| Codex | `3dr setup --lang zh-CN --agents codex` |
| Claude Code | `3dr setup --lang zh-CN --agents claude-code` |
| Cursor | `3dr setup --lang zh-CN --agents cursor` |
| OpenCode | `3dr setup --lang zh-CN --agents opencode` |
| Other local stdio MCP host | `3dr setup --lang zh-CN --agents none`, then run `3dr config` and add its `mcpServers.3dr` entry to the host configuration. Preserve the other entries. |

**3. Check the account connection.** Run `3dr status`. If it reports `"connected": false` (exit code 1), installation is complete and authorization is pending. To connect, run `3dr login` and keep the process running while the user signs in and approves this device, its tools and spending limits on the website. If the browser cannot open automatically, `3dr login --no-browser` prints a link for the user to open on the same computer. Once login returns, run `3dr status` again. With `"connected": true`, run `3dr tools` to verify access without generating media or spending credits.

Open a new agent session to load the installed Skill. A first request could be “给这张客厅照片做浅橡木和暖灰两套方案，先给我报价。”

## Host configuration and updates

Run `3dr update --check` to compare the installed version with the public GitHub `main` branch. It returns JSON with `current`, `latest` and `updateAvailable`. Run `3dr update` to install a newer version into the same global npm prefix. A preview version ahead of `main` stays installed.

`3dr status` and interactive setup, login and tool listing check at most once a day and write an available-update notice to stderr. The stdio server stays quiet. 更新提示会给出命令 `3dr update`。仅查看版本用 `3dr update --check`。使用较早版本、还没有这个命令时，重新运行上面的 GitHub 安装命令即可升级。

For a person using a terminal, `3dr setup` opens the language and host picker. For multiple requested hosts, supply a comma-separated list such as `3dr setup --lang en --agents codex,claude-code`. Rerun your host's setup command after a CLI update to refresh the installed Skill. The installer preserves locally edited copies.

The default Skill directories are `~/.agents/skills` (Codex), `~/.claude/skills` (Claude Code), `~/.cursor/skills` (Cursor) and `~/.config/opencode/skills` (OpenCode). Some hosts also read shared directories. For separate authorization or spending limits, use a named profile consistently, for example `3dr --profile studio login` and `3dr --profile studio status`. You can revoke that device in the website's **Account → MCP connections** page.

Terminal agents can use the Skill and CLI directly. For stdio on the official site, Codex also supports `codex mcp add 3dr -- 3dr serve` when `3dr` is on the host's PATH. `3dr config` prints a ready-to-copy JSON entry with absolute Node and script paths for GUI hosts, including Windows.

The default website is `https://3droomdesign.ai`. For a test deployment, use the login command and MCP entry from that site's **Account → MCP connections** page. To export an entry with absolute executable paths, set `THREEDR_SITE_ORIGIN` to the test website origin and run `3dr --profile runtime-qa config` in the same terminal as `3dr --profile runtime-qa login`. When returning to the official site, clear the test override in the shell and replace the host's test entry with the official one. Each site has its own authorization. If login reports missing OAuth metadata (HTTP 404 or an HTML page), check the site named in the error. For a test deployment, copy the commands from that deployment’s account page. The selected site must serve both MCP OAuth discovery documents before it can authorize this computer.

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

`login` uses the browser, authorization code with PKCE, and a temporary loopback callback. Use `login --no-browser` to open the printed link on the same computer. Tokens are saved in the operating system's credential store (macOS Keychain, Windows Credential Manager or an unlocked Linux Secret Service). Use `status` to check live access and `logout` to revoke it. A website revocation applies to subsequent requests. Declining consent or running `logout` stops background authorization prompts for that site and profile. To reconnect, run the login command shown for that profile. Each site and profile has its own credential. Requests go to the website’s MCP endpoint. Uploads send the selected file to a single-use signed destination.

## Distribution

The executable and bundled Agent Skill are licensed for use with your 3D Room Design account. See [LICENSE](LICENSE).
