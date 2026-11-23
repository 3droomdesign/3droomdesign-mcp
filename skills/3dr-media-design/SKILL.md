---
name: 3dr-media-design
description: Use 3D Room Design when the user wants an architectural rendering, a floor-plan image, interior style variations, or a design video from a room photo. Also supports site presets, shared images, house tours and CAD when authorized. 适用于 3DR 快捷生图、室内改风格、户型图和设计视频。
---

# 3DR media design

Use the installed `3dr` command on the user's computer. If the host already exposes the 3DR MCP tools, call those tools directly. Both use the same website grant and credit policy for the selected profile.

1. Run `3dr status` to check the connection. When sign-in is needed, ask the user to run `3dr login` in their terminal and approve the device on the 3DR site. The user handles login and any spending approvals.
2. Inspect `3dr tools` for this grant's tool names and input schemas. Use `3dr call list_design_presets` for current presets, parameters, prices and limits. Prefer the native preset matching the requested result. For instance, look up `ai-interior-design` for furnishing variants.
3. To use a local reference, upload only the selected file with `3dr upload ./room.png` and use its `input_ref`. For previously shared designs call `list_selected_assets`. A local path cannot serve as a remote asset reference.
4. For billable work, call `quote_tool` with the tool name and intended arguments. Submit the chosen generation with a unique `request_id`. Reuse that ID and the exact input on a network retry. When the run returns `awaiting_confirmation`, give the user its `approval_url` and wait for their decision on the website.
5. Poll `get_run` with the returned `run_id`; space out polls. Preserve successful variants on partial failure. Obtain fresh user approval for new paid work. Return the resulting `asset_ref`, or use `3dr download ASSET_REF ./result.png` with a new file path. A room image can be used as `start_ref` for `generate_design_video`. Return the actual result status and file type.

Shell clients can invoke any advertised tool with `3dr call TOOL --json '<object>'` or `3dr call TOOL --json -` and pipe the JSON object on stdin. Successful commands write JSON to stdout. Supply the same `--profile NAME` for every command if the user chose a named profile.

```sh
3dr call list_design_presets --json '{"preset_id":"ai-interior-design"}'
3dr call quote_tool --json '{"tool":"generate_floor_plan_image","arguments":{"brief":"Two bedrooms, open kitchen, north-facing entry"}}'
```
