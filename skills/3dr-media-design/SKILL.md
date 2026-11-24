---
name: 3dr-media-design
description: Install or connect 3dr for the current local agent, or use the user's 3D Room Design account for architectural renders, floor-plan images, room style variants, design videos, tours and CAD. 适用于安装 3DR、快捷生图、户型图和设计视频。
---

# 3DR media design

If the host already exposes the 3DR MCP tools, call them directly. A terminal-capable agent can use the local `3dr` CLI with the same website grant and credit policy.

For an installation request, run `npm install --global git+https://github.com/3droomdesign/3droomdesign-mcp.git` on the user's computer with Node.js 22+, npm and Git. Check `3dr --version`. Install this Skill without prompts using `3dr setup --lang en --agents codex` for Codex. Substitute `claude-code`, `cursor` or `opencode` for the current host, and use `--lang zh-CN` for Chinese. For a stdio-only host, use `--agents none` and register the entry printed by `3dr config`. A new agent session picks up the installed Skill.

For version questions, run `3dr update --check`. Relay an available-update notice and its `3dr update` command to the user. When asked to upgrade, run `3dr update` and rerun the current host's setup command to refresh the Skill. On an older CLI that lacks `update`, repeat the GitHub installation command.

1. Run `3dr status` to check the connection. If it reports `"connected": false`, start `3dr login` and keep it running while the user approves access in their browser on the same computer. Recheck `3dr status` after login. Use the same site and profile throughout setup. If the user declines, stop and wait for them to ask to reconnect. If the site reports missing OAuth metadata, check its Account → MCP connections instructions. The user handles account consent and spending approvals.
2. Inspect `3dr tools` for this grant's tool names and input schemas. Use `3dr call list_design_presets` for current presets, parameters, prices and limits. Prefer the native preset matching the requested result. For instance, look up `ai-interior-design` for furnishing variants.
3. To use a local reference, upload only the selected file with `3dr upload ./room.png` and use its `input_ref`. For previously shared designs call `list_selected_assets`. A local path cannot serve as a remote asset reference.
4. For billable work, look up the selected generation tool in `3dr tools`. Pass its design inputs in `quote_tool.arguments`, omitting `request_id`. To submit, call the generation tool directly with those same inputs and a new `request_id`. Reuse that ID and the exact inputs on a network retry. When the run returns `awaiting_confirmation`, give the user its `approval_url` and wait for their decision on the website.
5. Poll `get_run` with the returned `run_id`; space out polls. Preserve successful variants on partial failure. Obtain fresh user approval for new paid work. Return the resulting `asset_ref`, or use `3dr download ASSET_REF ./result.png` with a new file path. A room image can be used as `start_ref` for `generate_design_video`. Return the actual result status and file type.

Shell clients can invoke any advertised tool with `3dr call TOOL --json '<object>'` or `3dr call TOOL --json -` and pipe the JSON object on stdin. Successful commands write JSON to stdout. Supply the same `--profile NAME` for every command if the user chose a named profile.

```sh
3dr call list_design_presets --json '{"preset_id":"ai-interior-design"}'
3dr call quote_tool --json '{"tool":"render_architecture","arguments":{"brief":"Warm gray living room with a light oak coffee table","scene":"interior","model":"basic","render_mode":"photorealistic","image_count":1}}'
```
