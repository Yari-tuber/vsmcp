# 更新日志 / Changelog

**中文** | [English](#changelog-en)

本项目的所有重要变更都会记录在此文件中。
版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。

## [2.0.0] - 2026-11-05

改名 **VSMCP**（`yari.vsmcp`），把「每窗口 MCP 桥 + 多窗口路由器 + 工作区管理面板 + PowerShell 守护」合成一个插件。

### 新增

- **多窗口路由（内置 Hub）**：每个窗口照旧起自己的 MCP 服务（3333 起找空闲口），并登记到共享目录；所有窗口里只有一个抢到 Hub 端口 3340，外网隧道接在它上面，再转给「AI 现在操作的项目」所在窗口。自动跟随最后点过的窗口，或锁定某个项目；目标离线不改投、同一项目多开拒绝猜、每个请求发出时就定下目标。Hub 窗口关了，别的窗口几秒内接手，隧道也跟着在新 Hub 上重开
- **6 个增强工具**：`workspace_overview`、`list_directory`、`find_files`、`search_text`、`read_files`、`git_inspect`（只读、跳过依赖和常见凭据文件、真实路径防越界、校验 workspacePath）；搜索用 VS Code 自带的 ripgrep，不用另装
- **侧栏控制台**（WebviewView，跟随主题）：ChatGPT 连接地址、AI 当前项目、项目列表点一下锁定、连接自检、复制提示词；状态栏「GPT: 项目」「外网」
- **断线自动恢复**：启动宽限 90 秒、断开满 60 秒才重建、冷却 120→600 秒指数退避、手动恢复最短 30 秒；分层自检（项目 / Hub / 隧道 / 公网），状态变化写进事件日志
- 工具全部带 MCP annotations（只读工具 `readOnlyHint`，5 个破坏性工具 `destructiveHint`）
- node:test 单元测试 + 隔离 VS Code 实测脚本（`npm test`、`npm run e2e`）

### 变更

- 命令和设置统一为 `vsmcp.*`；`mcpServer.enableCloudflareTunnel` 改为 `vsmcp.autoStartTunnel`；`vsmcp.portFallback` 默认改为开（多开窗口需要）
- 默认不鉴权（`vsmcp.authToken` 留空），保留可选 Bearer
- `@modelcontextprotocol/sdk` 升到 1.32.2、zod 4；HTTP 超时放宽，长命令不会被掐断；`run_terminal_command` 默认超时 2 分钟（`vsmcp.commandTimeoutMs`），单次最长 1 小时
- `vsmcp.allowedCommands` 的说明改成和实际行为一致：留空 = 不限制

### 修复

- **Windows 终端**：持续终端改用 PowerShell，通过 Pseudoterminal 接入 VS Code，输入、stdout/stderr 和日志统一为 UTF-8；`kill` / `dispose` 用 `taskkill /T /F` 结束本管理器持有的进程树，避免留下子进程
- **孤儿 cloudflared**：启动后立即在共享记录中保存 PID、启动时间、metrics 地址和 Hub 端口；新 Hub 接手及启动隧道前先核对 PID 存活与命令行，仅在可执行文件、tunnel 命令及 Hub URL 端口或 metrics 地址匹配时结束该 PID，不按名称批量结束进程
- **鉴权健康接口隐私**：设置 `vsmcp.authToken` 后，Hub 的 `/health` 和 `/` 只返回 `status`、`service`、`instance`，窗口直连接口只返回 `status`、`service`，不再返回项目名或路径；健康接口仍可匿名访问，未设置令牌时保留原字段

## [1.0.1] - 2026-09-23

### 新增

- **固定端口策略**：`mcpServer.port` 默认严格绑定，本地地址 `http://127.0.0.1:3333/...` 跨重启不再漂移；端口被占用时给出占用进程（PID）以及「打开端口设置 / 复制占用信息 / 重试」操作，旧版自动顺延行为移入 `mcpServer.portFallback`（默认关闭）
- **令牌隧道（固定公网地址）**：新增 `mcpServer.tunnelTokenFile`，配合 `mcpServer.tunnelHostname` 运行 `cloudflared tunnel run --token`，用户端无需 Cloudflare 账号 / 域名 / 登录
- **localtunnel 隧道（零账号、零域名）**：新增 `mcpServer.tunnelProvider`（`cloudflare` / `localtunnel`）与 `mcpServer.tunnelSubdomain`，可得到固定地址 `https://<子域名>.loca.lt/mcp`，且免安装 cloudflared
- **新命令**：「设置隧道令牌」「清除隧道令牌」；管理面板新增 🔑 按钮与隧道令牌状态显示

### 修复

- **本地地址每次启动都不一样**：根因是端口被占用时静默顺延到 3334–3337，导致 MCP 地址漂移
- **loca.lt 静默降级**：请求的固定子域名当下不可用时，loca.lt 不报错而是返回一个随机子域名，使「固定地址」悄悄失效。现在会校验实际分配到的子域名并自动重试（每 5 秒 × 18 次 ≈ 85 秒，覆盖实测的 55–60 秒释放窗口），仍失败则明确报错，不再把随机地址当成固定地址展示
- **子域名占用者诊断**：失败时探测 `https://<子域名>.loca.lt/health`，区分「你自己的另一个 VS Code 窗口」「被别人占用」「旧连接尚未超时释放」，并提供「用随机地址启动」退路

### 安全

- **隧道令牌不再是设置项**：改存 VS Code 系统凭据库（SecretStorage），无法被 Settings Sync 同步或被 git 提交；cloudflared 输出中的令牌会先脱敏再写入日志

### 文档

- README 新增「固定公网地址（给多个用户分发时必读）」「令牌安全」与「免费域名 / 隧道服务实机实测」章节

## [1.0.0] - 2026-09-15

首个公开版本。基于 MIT 协议的开源项目
[vscode-mcp-bridge](https://github.com/jhamama/vscode-mcp-bridge) 二次开发。

### 新增

- **27 个 MCP 工具**：上下文感知、文件读写、LSP 导航、重构/快速修复、终端管理
- **双传输端点**：`/sse`（经典 SSE）与 `/mcp`（Streamable HTTP，远程/代理环境推荐）
- **cloudflared 外网隧道**：一键把本机 VS Code 暴露到公网，支持 winget 自动安装引导
- **MCP 桥接面板**：实时显示外网地址，一键复制地址 / 复制关键提示词
- **可选 Bearer Token 鉴权**与 `execute_vscode_command` 命令白名单
- **GitHub Actions 工作流**：推送自动做类型检查 + 编译 + 打包 VSIX，打 tag 自动发 Release
- **中英双语文档**：README 与 CHANGELOG 均提供简体中文与 English 两个版本

### 变更

- 项目名统一为 `vscode-mcp-api`（扩展 ID：`jhamama.vscode-mcp-api`）
- 版本号改为构建时从 `package.json` 注入（`__EXT_VERSION__`），消除多处硬编码导致的版本漂移

### 安全

- 公网隧道 + 未设置 `mcpServer.authToken` 时，扩展会主动弹出安全警告
- `execute_vscode_command` 默认全部禁止，仅执行白名单内的命令

---

<a id="changelog-en"></a>

# Changelog

[中文](#更新日志--changelog) | **English**

All notable changes to this project are recorded in this file.
Versioning follows [Semantic Versioning 2.0.0](https://semver.org/).

## [2.0.0] - 2026-11-05

Renamed to **VSMCP** (`yari.vsmcp`), combining the per-window MCP bridge, multi-window router, workspace panel, and PowerShell watchdog into one extension.

### Added

- **Multi-window routing with a built-in Hub**: each window runs its own MCP server, starting at port 3333, and registers in shared storage. One window owns Hub port 3340; the public tunnel connects to it and requests are forwarded to the selected project. Follow the last focused window or lock a project. Offline targets produce an error without redirecting, duplicate workspaces are rejected, and each request keeps the target selected when it starts. Another window takes over if the Hub closes and restarts the tunnel
- **Six enhanced tools**: `workspace_overview`, `list_directory`, `find_files`, `search_text`, `read_files`, and `git_inspect`; read-only, with dependency and credential filtering, real-path boundary checks, and workspacePath validation. Search uses VS Code's bundled ripgrep
- **Theme-aware sidebar control panel** (WebviewView): ChatGPT connection URL, current AI target, click-to-lock project list, connection checks, and copyable prompts; status bar entries for the target project and public access
- **Automatic recovery**: 90-second startup grace period, at least 60 seconds offline before rebuilding, exponential cooldown from 120 to 600 seconds, and at least 30 seconds between manual recoveries. Layered checks cover project, Hub, tunnel, and public endpoint; state changes are logged
- MCP annotations on all tools: `readOnlyHint` for read-only tools and `destructiveHint` on five destructive tools
- node:test unit tests and an isolated VS Code integration script (`npm test`, `npm run e2e`)

### Changed

- Commands and settings now use `vsmcp.*`; `mcpServer.enableCloudflareTunnel` becomes `vsmcp.autoStartTunnel`. `vsmcp.portFallback` now defaults to enabled for multiple windows
- Authentication is off by default (empty `vsmcp.authToken`), with optional Bearer authentication retained
- Upgraded `@modelcontextprotocol/sdk` to 1.32.2 and zod to 4; relaxed HTTP timeouts for long commands. `run_terminal_command` defaults to two minutes (`vsmcp.commandTimeoutMs`), with a per-call maximum of one hour
- Corrected the description of `vsmcp.allowedCommands` to match its behavior: an empty list means unrestricted

### Fixed

- **Windows terminals**: persistent terminals now use PowerShell through a VS Code Pseudoterminal, with UTF-8 input, stdout/stderr, and logs. `kill` / `dispose` use `taskkill /T /F` on process trees owned by the terminal manager so child processes are also stopped
- **Orphaned cloudflared processes**: persist the PID, start time, metrics address, and Hub port immediately after launch. Before takeover or tunnel startup, verify that the recorded PID is alive and its command line matches the executable, tunnel command, and exact Hub URL port or recorded metrics address; only then terminate that PID, without killing processes by name
- **Health endpoint privacy with authentication**: when `vsmcp.authToken` is set, Hub `/health` and `/` return only `status`, `service`, and `instance`; direct window endpoints return only `status` and `service`. Project names and paths are omitted. Health endpoints remain anonymously accessible, and the original fields are retained when no token is set

## [1.0.1] - 2026-09-23

### Added

- **Pinned port policy**: `mcpServer.port` is now strictly honoured, so the local address `http://127.0.0.1:3333/...` no longer drifts across restarts; a busy port reports the owning process (PID) with "open port settings / copy details / retry" actions. The legacy auto-increment behaviour moved to `mcpServer.portFallback` (off by default)
- **Token tunnel (fixed public URL)**: new `mcpServer.tunnelTokenFile`, paired with `mcpServer.tunnelHostname`, runs `cloudflared tunnel run --token` — no Cloudflare account, domain or login needed on the user side
- **localtunnel provider (no account, no domain)**: new `mcpServer.tunnelProvider` (`cloudflare` / `localtunnel`) and `mcpServer.tunnelSubdomain`, giving a fixed `https://<subdomain>.loca.lt/mcp` without installing cloudflared
- **New commands**: "Set Tunnel Token" and "Clear Tunnel Token"; the panel gained a 🔑 button and a tunnel-token status indicator

### Fixed

- **Local address changed on every startup**: caused by silently falling back to ports 3334–3337 when the configured port was busy
- **loca.lt silent downgrade**: when the requested subdomain is momentarily unavailable, loca.lt returns a random subdomain instead of failing, which silently broke the "fixed address" promise. The extension now verifies the assigned subdomain and retries (every 5 s × 18 ≈ 85 s, covering the measured 55–60 s release window), then fails loudly instead of presenting a random address as your fixed one
- **Subdomain holder diagnostics**: on failure it probes `https://<subdomain>.loca.lt/health` to distinguish "your own other VS Code window", "taken by someone else" and "old connection not yet timed out", and offers a "start with a random address" fallback

### Security

- **The tunnel token is no longer a setting**: it is stored in the VS Code OS credential store (SecretStorage), so it cannot be Settings-Synced or committed; tokens in cloudflared output are redacted before logging

### Docs

- README gained "Fixed public URL (required reading when distributing to many users)", "Token security" and "Measured results for free domain / tunnel services" sections

## [1.0.0] - 2026-09-15

First public release. Derived from the MIT-licensed open-source project
[vscode-mcp-bridge](https://github.com/jhamama/vscode-mcp-bridge).

### Added

- **27 MCP tools**: context awareness, file read/write, LSP navigation, refactor/quick fix, terminal management
- **Dual transport endpoints**: `/sse` (classic SSE) and `/mcp` (Streamable HTTP, recommended for remote or proxied setups)
- **Cloudflare tunnel**: expose your local VS Code to the internet with one click, with guided `winget` installation
- **MCP Bridge Panel**: live public URL with one-click copy for the URL and the starter prompt
- **Optional Bearer token auth** and an allowlist for `execute_vscode_command`
- **GitHub Actions workflow**: type check + build + VSIX packaging on every push, automatic Release on tag push
- **Bilingual docs**: both README and CHANGELOG ship in Simplified Chinese and English

### Changed

- Renamed the project to `vscode-mcp-api` (extension ID: `jhamama.vscode-mcp-api`)
- The version is now injected at build time from `package.json` (`__EXT_VERSION__`), removing hardcoded duplicates

### Security

- The extension warns you when a public tunnel is running without `mcpServer.authToken`
- `execute_vscode_command` denies everything by default; only allowlisted commands run
