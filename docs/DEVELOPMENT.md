# VSMCP 2.0 开发说明

VSMCP 是 `yari.vsmcp` VS Code 扩展：每个窗口运行 MCP 服务，一个内置 Hub 统一路由，并由 Hub 管理公网隧道。用户安装与连接步骤见 [中文 README](../README.md)、[English README](../README.en.md) 和 [Agent 安装说明](../AGENTS.md)；测试步骤见 [TESTING.md](../TESTING.md)。

## 架构

```text
ChatGPT / MCP 客户端
        │ HTTPS（外网）或本机 HTTP
        ▼
cloudflared / localtunnel（由 Hub 窗口管理）
        │
        ▼
127.0.0.1:3340  Hub（仅一个窗口持有）
        │ 按共享路由状态选择目标
        ▼
127.0.0.1:3333–3337  每窗口 MCP 服务（33 个工具）
```

- 窗口服务从 `vsmcp.port`（默认 3333）开始找空闲端口，最多尝试 5 个，跳过 `vsmcp.hubPort`；`vsmcp.portFallback` 默认开启。
- 每个窗口每 3 秒登记心跳，10 秒过期；每 3 秒竞争监听 Hub 端口，成功者成为 Hub。关窗后其他窗口接手；已有报告观察到约 1–2.6 秒，实际时间取决于运行环境。
- Hub 转发 `/mcp`、`/sse` 和 `/messages`。普通请求发出时固定目标；SSE 消息绑定建立会话时的窗口。切项目不会把进行中的请求转给其他项目。
- 自动跟随最后获得焦点且有项目的窗口；手动模式锁定工作区 key。目标离线报错、不改投；同一工作区多开拒绝猜测；空窗口不当目标。增强工具校验 `workspacePath`，切换后先重新调用 `workspace_overview`。
- 默认不鉴权，保留可选 `vsmcp.authToken` Bearer。开启后 `/health` 和 `/` 仍可匿名访问，但 Hub 仅返回 `status`、`service`、`instance`，窗口仅返回 `status`、`service`；Hub 无目标仍返回 503。
- 共 33 个工具：保留 27 个上游工具并增加 6 个项目工具；21 个带 `readOnlyHint`，5 个带 `destructiveHint`。预览差异使用 `vsmcp-preview:` 内存文件系统。

### 共享目录

根目录是扩展的 `context.globalStorageUri`；标准 Windows VS Code 为 `%APPDATA%\Code\User\globalStorage\yari.vsmcp\`。隔离测试、其他编辑器分支使用各自的用户数据目录，不能硬编码日常目录。

| 文件 | 作用 |
|---|---|
| `windows/<sessionId>.json` | 每窗口的 PID、端口、项目名/文件夹、工作区 key、焦点时间、心跳和版本；关窗删除 |
| `state.json` | 自动/手动路由、锁定 key、`tunnelWanted` 外网意愿，以及跨窗口恢复请求/隧道配置变更时间；原子写入 |
| `focus.json` | 最后获得焦点的有项目窗口；独立于窗口登记保留，避免目标消失后自动改投 |
| `hub.json` | 当前 Hub 身份、端口、心跳和随机实例号 |
| `tunnel.json` | 隧道状态、带 `/mcp` 的连接 URL、旧地址/变化时间、provider/kind，以及 `pid`、`processStartedAt`、`metricsAddress`、`hubPort` 进程身份 |
| `diagnostics.json` | 项目、Hub、隧道、公网四层自检结果 |
| `events.jsonl` | 只记录状态变化；超过 1 MB 轮转 |
| `localtunnel-subdomain.txt` | 自动生成的 localtunnel 子域名，供新 Hub 继续复用 |

共享 JSON 通过临时文件加改名原子写入。隧道令牌存 SecretStorage（系统凭据库），或由设置引用仓库外的令牌文件；不要写入仓库或日志。

### 隧道看护

只有 Hub 启动隧道，并指向 Hub 端口。支持 Cloudflare 临时/令牌/命名隧道及 localtunnel。新 Hub 接手后按共享 `tunnelWanted` 重开；临时 URL 变化会在面板提示。整个 VS Code 重启、没有其他在线窗口且旧隧道状态超过 60 秒时，外网意愿回到 `vsmcp.autoStartTunnel`（默认 false）。

自动恢复条件为启动宽限 90 秒、连续断开至少 60 秒、满足冷却间隔；退避 120→240→480→600 秒封顶，恢复后复位。手动恢复最少间隔 30 秒。关外网停止看护，不可恢复错误等待人工处理；可用 `vsmcp.autoRecover` 关闭自动恢复。

cloudflared 使用本机 metrics 地址，通过 `/ready` 获取连接状态；公网自检核对 Hub `/health` 的随机实例号，避免误连旧 Hub。启动子进程后立即写入身份，不等待公网 URL 返回。接手/启动前清理孤儿时，先确认 PID 存活，再核对命令行中的可执行文件名、tunnel 命令及精确的 Hub URL 端口或记录中的 metrics 地址，确认后仅结束该 PID。禁止按名称批量结束 cloudflared；取不到命令行就不杀。

## 关键源码文件

| 文件 | 职责 |
|---|---|
| `src/extension.ts` | 扩展激活/释放，连接窗口服务、Hub、命令和 UI |
| `src/hub/registry.ts` | 共享文件、窗口心跳、路由及隧道记录 |
| `src/hub/route.ts` | 自动跟随、锁定、离线/多开判定等纯路由逻辑 |
| `src/hub/HubServer.ts` | Hub HTTP 转发、SSE 会话绑定及健康接口 |
| `src/hub/HubRuntime.ts` | Hub 端口选举、接手、跨窗口请求和隧道生命周期 |
| `src/tunnel/recoveryPolicy.ts` | 恢复门槛、冷却及指数退避策略 |
| `src/tunnel/TunnelSupervisor.ts` | 看护隧道状态、自检及恢复调度 |
| `src/tunnel/CloudflareTunnel.ts` / `LocaltunnelTunnel.ts` | 两类隧道 provider，保留并调整上游实现 |
| `src/tunnel/orphanProcess.ts` | 读取进程命令行、核对 cloudflared 身份并按 PID 回收 |
| `src/tools/index.ts` / `catalog.ts` | 注册 27 + 6 个工具及其 annotations |
| `src/tools/workspaceTools.ts` / `ripgrep.ts` | 增强只读工具、路径与凭据过滤、rg 定位及逐文件扫描兜底 |
| `src/server/HttpServer.ts` | 每窗口的 HTTP、Streamable HTTP、SSE 及可选鉴权 |
| `src/bridge/VsCodeBridge.ts` | 封装 VS Code 编辑器、文件和语言服务 API |
| `src/terminal/TerminalManager.ts` | 持续终端；Windows 使用 UTF-8 PowerShell / Pseudoterminal，taskkill `/T /F` 回收所持进程树；macOS/Linux 保留 bash + script |
| `src/diagnostics/diagnostics.ts` | 四层自检分类与事件记录 |
| `src/ui/PanelProvider.ts` / `panelState.ts` / `prompts.ts` | 侧栏 WebviewView、面板数据和复制提示词 |
| `media/panel.html` / `panel.css` / `panel.js` | 面板外壳、VS Code 主题样式和 postMessage 渲染 |
| `media/panel-demo.html` / `media/icon.svg` | 假数据面板演示及活动栏图标 |
| `test/*.test.ts` / `test/terminalHost.ts` | 单元/本机进程测试及 VS Code 测试接口替身 |
| `scripts/build-tests.mjs` / `scripts/e2e/isolated.mjs` | 测试打包、隔离 VS Code 实测 |

## 构建、测试和打包

在仓库根目录执行（需要 Node.js、npm；建议 Node 22 LTS）：

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run package
npm run e2e
```

- `build` 用 esbuild 输出 `out/extension.js`（CJS，`vscode` 为外部依赖）；开发可用 `npm run watch`。
- `package` 为 `vsce package --no-dependencies`，prepublish 会先执行 `build:prod`；依赖已打进 bundle。输出根目录 `vsmcp-2.0.0.vsix`。
- `npm test` 的 Windows 基线是 68 项；`npm run e2e` 安装预先打好的 VSIX到 `.vscode-test` 隔离环境，窗口 13333–13337、Hub 13340，结果为 `.vscode-test/e2e-result.json`，不打开真实公网隧道。详细范围和限制见 [测试说明](../TESTING.md)。
- `.vscodeignore` 排除源码、测试、内部报告、`docs/**`、`AGENTS.md` 和英文 README；保留发布包需要的 `README.md`、`CHANGELOG.md`、`LICENSE`。
- 开发测试不要占用日常部署的 3333–3340、3350，不要改现有 cloudflared 配置或结束其他服务。另一项实测使用 `.vscode-test` 时不要并行运行或清理。

### Windows 长 PATH 的临时绕法

此机器的既有报告记录：Git Bash 中 PATH 长达 8236 字符，npm 默认使用的 cmd.exe 得到空 PATH，导致 postinstall / vsce prepublish 提示找不到 `node`。这是该环境的历史诊断；遇到类似错误时先核对 PATH 和实际 Node 安装位置。

可以只在当前 PowerShell 会话的命令期间，改用 Git Bash 执行 npm 脚本，并将 PATH 临时缩短；结束后恢复，**不写用户/系统环境变量**：

```powershell
$buildSavedPath = $env:Path
$buildSavedShell = $env:npm_config_script_shell
try {
    $buildNodeDir = Split-Path (Get-Command node.exe -ErrorAction Stop).Source
    $buildGitDir = Split-Path (Get-Command git.exe -ErrorAction Stop).Source
    $buildBash = 'C:\Program Files\Git\bin\bash.exe' # 按本机 Git 安装位置调整
    if (-not (Test-Path -LiteralPath $buildBash)) { throw '请填写实际 bash.exe 路径' }
    $env:npm_config_script_shell = $buildBash
    $env:Path = "$buildNodeDir;$buildGitDir;$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
    npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci 失败' }
    npm.cmd run package
    if ($LASTEXITCODE -ne 0) { throw '打包失败' }
} finally {
    $env:Path = $buildSavedPath
    $env:npm_config_script_shell = $buildSavedShell
}
```

Node/npm 不在同一目录或 Git 安装布局不同时，按实际路径补齐。原报告另有 npm 11 allow-scripts 拦截 esbuild / vsce-sign postinstall 的提示；当时构建和打包成功，遇到安装脚本拦截时应检查具体日志。

## 和上游的关系

- [jhamama/vscode-mcp-bridge](https://github.com/jhamama/vscode-mcp-bridge) 提供原始 VS Code ↔ MCP 桥接能力。
- [Danchuna/vscode-mcp-api](https://github.com/Danchuna/vscode-mcp-api) 增加中文化和 Cloudflare/localtunnel 公网隧道；VSMCP 从它的 v1.0.1 起步，保留完整提交历史。
- 两层上游均为 MIT；保留 LICENSE 原版权行并增加本项目署名。
- 2.0 新增 Hub 多窗口路由、6 个增强工具、侧栏控制台、隧道看护和工具 annotations；命令/设置使用 `vsmcp.*`，旧上游配置不会自动迁移。旧路由器、焦点扩展和外部 PowerShell 守护不属于新架构，日常部署切换需由使用者决定如何停用旧组件。

## 网络实测（来自上游）

以下保留自原 `CONTEXT.md`，是上游当时的网络结果，**本轮未复测，也不保证当前地区、运营商或时段仍然相同**：

- `*.workers.dev` 在中国大陆出现 SNI 阻断：使用 `--resolve` 绕过 DNS、指定真实 Cloudflare 边缘 IP 仍失败，而同 IP 使用 `cloudflare.com` SNI 返回 200，因此当时放弃 workers.dev 中继方案。
- `loca.lt` 的真实端到端 GET/POST 均返回 200，没有中间确认页；子域名先到先得，不能真正预留，需校验实际分配结果。
- 当时 `loca.lt`、`serveo.net`、`ngrok-free.app`、`devtunnels.ms`、`pages.dev` 可达；`vercel.app`、`fly.dev`、`onrender.com`、`ngrok.io`、`cpolar.top`、`vicp.net` 超时。

当前 2.0 报告中的公网 provider、真实重连、ChatGPT 网页连接及跨平台仍需实机验收；不要把这些历史结果当成 2.0 已通过的网络测试。
