# 3D Room Design MCP

**English** | [简体中文](./README.zh-CN.md)

Give your agent access to your 3D Room Design account to restyle a room photo, render an architectural sketch, preview a floor plan or make a design video. The `3dr` command includes an Agent Skill for terminal-capable agents and a local MCP server for stdio hosts.

## Ask your agent to install 3dr

Paste this request into an agent that can run commands on your computer.

> Follow the instructions at https://github.com/3droomdesign/3droomdesign-mcp to install and configure 3dr for this agent, show me the website and device code if I need to authorize this agent, then list the available design tools.

On the first connection, you choose which tools the agent can use and how many credits it can spend. You can revoke access later under **Account → MCP connections** on the website.

### Setup steps for the agent

**1. Install the CLI on the computer that runs the agent.** Check `node --version` (22 or newer), `npm --version` and `git --version`. Run the following from any directory. Use the same command to update an existing GitHub installation.

```sh
npm install --global git+https://github.com/3droomdesign/3droomdesign-mcp.git
3dr --version
```

**2. Run the one setup command for the host you are running in.** These commands work without a TTY. Use `--lang en` for English or `--lang zh-CN` for Simplified Chinese.

| Current host | Run this command |
| --- | --- |
| Codex | `3dr setup --lang en --agents codex` |
| Claude Code | `3dr setup --lang en --agents claude-code` |
| Cursor | `3dr setup --lang en --agents cursor` |
| OpenCode | `3dr setup --lang en --agents opencode` |
| Other local stdio MCP host | `3dr setup --lang en --agents none`, then run `3dr config` and add its `mcpServers.3dr` entry to the host configuration. Preserve the other entries. |

**3. Check the account connection.** Run `3dr status`. If it reports `"connected": false` (exit code 1), installation is complete and authorization is pending. Run `3dr login` and keep it running. Give the user the verification URL and short code printed by 3dr. They can open the URL on their computer or phone, match the code and approve the agent’s tools and spending limits. This also works over SSH or through a remote agent. Once login returns, run `3dr status` again. With `"connected": true`, run `3dr tools` to verify access without generating media or spending credits.

Open a new agent session to load the installed Skill. Try asking, “Use this living room photo to propose two designs, one in light oak and one in warm gray. Give me a quote first.”

## Host configuration and updates

Run `3dr update --check` to compare the installed version with the public GitHub `main` branch. It returns JSON with `current`, `latest` and `updateAvailable`. Run `3dr update` to install a newer version into the same global npm prefix. A preview version ahead of `main` stays installed.

`3dr status` and interactive setup, login and tool listing check at most once a day. When an update is available, the notice on stderr includes the `3dr update` command. The stdio server stays quiet. If your version predates this command, rerun the GitHub installation command above.

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

If a download is interrupted, keep the same command running. It automatically requests the missing bytes in small ranges when the asset has a checksum or a strong ETag. Servers that return the full file can restart the transfer. The destination is created after the size and any available SHA-256 have been verified. Use a new destination path for each download.

Use `3dr call TOOL --json -` to read an argument object from stdin. Successful data commands print JSON. Each connection sees its granted tools, selected site images and its own results. Discover available presets at runtime. For a quote, put the selected tool’s design inputs in `quote_tool.arguments` and omit `request_id`. For submission, call the generation tool directly with the same inputs and a new `request_id`. Reuse that ID when retrying the same generation. If a run requires confirmation, open its approval link on the website, then use `get_run` with its `run_id`. The bundled [skill](skills/3dr-media-design/SKILL.md) also covers variants, video, tours and CAD.

`3dr login` uses a device code when the website supports it. The CLI polls for the user’s decision from the computer running the agent. Interactive desktop terminals also open the verification page. Use `3dr login --device --no-browser` to print the link and code without opening a browser. If the code expires, start login again. For a local browser callback, use `3dr login --loopback` (authorization code with PKCE). Sites without device-code support automatically use this older flow and require the browser to run on the same computer as 3dr, including with `--no-browser`. Tokens are saved in the operating system's credential store (macOS Keychain, Windows Credential Manager or an unlocked Linux Secret Service). On a remote Linux host, the agent’s own login session must have access to that credential store. Use `status` to check live access and `logout` to revoke it. A website revocation applies to subsequent requests. Declining consent or running `logout` stops background authorization prompts for that site and profile. To reconnect, run the login command shown for that profile. Each site and profile has its own credential. Requests go to the website’s MCP endpoint. Uploads send the selected file to a single-use signed destination.

## Distribution

The executable and bundled Agent Skill are licensed for use with your 3D Room Design account. See [LICENSE](LICENSE).
