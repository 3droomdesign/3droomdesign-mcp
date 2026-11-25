# 3D Room Design MCP

[English](./README.md) | **简体中文**

让你的 AI 助手用你的 3D Room Design 账户为房间照片尝试不同风格、渲染建筑草图、预览户型或制作设计视频。`3dr` 提供两种接入方式：能操作本机终端的助手可以使用随附的技能（Agent Skill），支持标准输入输出（stdio）的 MCP 客户端可以启动本地 MCP 服务。

## 让 AI 助手安装

把这句话发给能操作本机终端的 AI 助手：

> 请按 https://github.com/3droomdesign/3droomdesign-mcp/blob/main/README.zh-CN.md 的简体中文步骤为当前助手安装并配置 3dr，需要授权时把网址和设备码发给我确认，最后列出可用的设计工具。

助手可以完成安装、选择客户端并检查连接。首次连接时，你在浏览器里选择允许使用的工具和积分限额。你可以随时在网站的「账户 → MCP 连接」中撤销授权。

### 给 Agent 的安装步骤

**1. 在运行助手的电脑上安装命令行工具。** 运行 `node --version` 确认 Node.js 为 22 或更高版本，用 `npm --version` 和 `git --version` 确认 npm 和 Git 均可用。在任意目录执行以下命令。已有的 GitHub 安装也可以用同一条安装命令更新。

```sh
npm install --global git+https://github.com/3droomdesign/3droomdesign-mcp.git
3dr --version
```

**2. 只运行当前客户端对应的一条配置命令。** 下列命令可在没有交互式终端（TTY）的环境中执行。`--lang zh-CN` 选择简体中文，`--lang en` 选择英文。

| 当前客户端 | 配置命令 |
| --- | --- |
| Codex | `3dr setup --lang zh-CN --agents codex` |
| Claude Code | `3dr setup --lang zh-CN --agents claude-code` |
| Cursor | `3dr setup --lang zh-CN --agents cursor` |
| OpenCode | `3dr setup --lang zh-CN --agents opencode` |
| 其他支持本地 stdio 的 MCP 客户端 | 运行 `3dr setup --lang zh-CN --agents none`，再运行 `3dr config`，将输出中的 `mcpServers.3dr` 条目添加到客户端配置中，保留已有条目。 |

**3. 检查账户连接。** 运行 `3dr status`。如果返回 `"connected": false`（退出码 1），说明已安装，正在等待用户授权。运行 `3dr login` 并保持命令运行。将输出的验证网址和短设备码交给用户，用户可以在电脑或手机浏览器打开网址，核对设备码，选择工具并确认积分权限。SSH 终端和远程 Agent 也使用这套步骤。登录命令结束后，再次运行 `3dr status`。看到 `"connected": true` 后，运行 `3dr tools` 查看可用工具。这一步不会生成图片或视频，也不消耗积分。

新开一个助手会话，让它加载刚安装的技能。你可以这样试用：“给这张客厅照片做两套方案，一套浅橡木色，一套暖灰色，先给我报价。”

## 客户端配置与更新

运行 `3dr update --check` 可比较本地版本与 GitHub 公开仓库 `main` 分支上的版本。返回的 JSON 包含当前版本 `current`、最新版本 `latest` 和是否可更新 `updateAvailable`。运行 `3dr update` 会将新版本安装到原来的 npm 全局安装目录。若当前安装的是比 `main` 更新的预览版，会保留该版本。

`3dr status` 以及在交互式终端中配置客户端、登录或列出工具时，最多每天检查一次更新。发现新版时，更新提示会写入标准错误输出，并给出 `3dr update` 命令。stdio 服务不会输出这类提示。若使用的旧版本尚无更新命令，重新执行上面的 GitHub 安装命令即可。

手动配置时，运行 `3dr setup` 即可选择语言和客户端。要同时为多个客户端安装技能，请用逗号分隔客户端名称，例如 `3dr setup --lang zh-CN --agents codex,claude-code`。更新命令行工具后，再执行一次对应客户端的配置命令即可刷新技能。安装程序会保留你在本地修改过的技能文件。

默认技能目录为 `~/.agents/skills`（Codex）、`~/.claude/skills`（Claude Code）、`~/.cursor/skills`（Cursor）和 `~/.config/opencode/skills`（OpenCode）。有些客户端也会读取共享技能目录。如果需要单独授权或设置独立积分限额，请给连接指定一个配置名称，并在后续命令中沿用，例如 `3dr --profile studio login` 和 `3dr --profile studio status`。你可以在网站的「账户 → MCP 连接」页面撤销该设备的授权。

能操作终端的助手可以直接使用技能和命令行工具。在官网环境中，如果客户端的 `PATH` 能找到 `3dr`，Codex 也可以通过 `codex mcp add 3dr -- 3dr serve` 接入 stdio 服务。对于图形界面客户端（包括 Windows 上的客户端），运行 `3dr config` 可以得到可直接复制的 JSON 配置，其中包含 Node 和脚本的绝对路径。

默认站点为 `https://3droomdesign.ai`。连接测试站时，请使用该站「账户 → MCP 连接」页面给出的登录命令和 MCP 配置。要导出含绝对路径的配置，请在同一个终端中将 `THREEDR_SITE_ORIGIN` 设为测试站地址（含协议和域名），然后运行 `3dr --profile runtime-qa login` 和 `3dr --profile runtime-qa config`。切回官网时，请清除终端里的测试站变量，并将客户端的测试配置换成官网配置。每个站点需要单独授权。如果登录提示缺少 OAuth 元数据（HTTP 404 或返回 HTML 页面），请核对报错中的站点地址。测试站的命令可从其账户页复制。所选站点必须提供两份 MCP OAuth 发现文档，才能授权这台电脑。

## 工具与用户数据

```sh
3dr tools
3dr call list_design_presets
3dr upload ./room.png
3dr call list_selected_assets --json '{"limit":5}'
3dr call quote_tool --json '{"tool":"generate_floor_plan_image","arguments":{"brief":"两间卧室和一个开放式厨房"}}'
3dr download ASSET_REF ./result.png
```

下载中断时，让原命令继续运行即可。如果资源带有校验和或强 ETag，命令会自动分段请求缺失的字节。如果服务器只返回完整文件，命令可以从头重新下载。文件大小和可用的 SHA-256 校验和验证通过后，才会写入目标路径。每次下载请使用新的目标路径。

使用 `3dr call TOOL --json -` 可从标准输入读取 JSON 参数对象。数据命令成功时输出 JSON。每个连接只能看到已授权的工具、为其选中的站内图片和它自己生成的结果。可用预设可通过 `list_design_presets` 实时查询。

报价时，把所选工具的设计参数放在 `quote_tool.arguments` 中，省略 `request_id`。正式生成时，直接调用生成工具，沿用同一组设计参数，再加上新的 `request_id`。重试同一次生成时，请复用原来的 ID。如果任务需要确认，请在网站上打开任务返回的审批链接，然后使用 `get_run` 和对应的 `run_id` 查询进度。多方案、视频、漫游和 CAD 的调用方法见[随附技能](skills/3dr-media-design/SKILL.md)。

网站支持设备码时，`3dr login` 默认使用设备码，运行 Agent 的电脑会自动查询授权结果。在本机交互式桌面终端中会同时打开验证页面。使用 `3dr login --device --no-browser` 可以只显示网址和设备码。设备码过期后可重新运行登录命令。需要本机回调时，使用 `3dr login --loopback`，通过 PKCE 授权码登录。旧站点会自动使用本机回调，此时即使加上 `--no-browser`，浏览器也需要与 3dr 在同一台电脑上。令牌保存在操作系统的凭据库中：macOS 钥匙串、Windows 凭据管理器或 Linux 上已解锁的 Secret Service。通过远程 Linux 主机使用时，应让运行 Agent 的会话能够访问该凭据库。

使用 `3dr status` 检查当前连接，使用 `3dr logout` 撤销授权。在网站上撤销授权，会对之后的请求生效。拒绝授权或运行 `3dr logout` 后，此站点和配置将停止在后台提示授权。如需重新连接，请运行该配置对应的登录命令。每个站点和配置使用独立凭据。工具请求发送至站点的 MCP 端点，上传操作只将选中的文件发送至一次性签名地址。

## 许可

可执行程序及随附的助手技能按许可证条款供你配合自己的 3D Room Design 账户使用。详见[许可证](LICENSE)。
