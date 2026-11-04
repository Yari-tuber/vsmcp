# VSMCP 2.0 测试说明

本说明区分单元测试、隔离 VS Code 实测和人工端到端验收。2026-11-05 的实现报告记录了原有 55 项单测及 31 项隔离实测；后续三处问题修复报告将单测基线更新为 **68/68 通过**。这些是既有报告中的结果，不代表阅读本文时已重新执行；复测以当次输出为准。

## 准备环境

- 安装 Node.js（建议 22 LTS）和 npm；Git 用于 `git_inspect` 测试。
- 在仓库根目录执行 `npm ci` 安装锁定依赖。
- 隔离实测使用图形桌面环境和预先打好的 `vsmcp-2.0.0.vsix`；当前脚本含 Windows 命令，已有运行证据来自 Windows。
- Windows 出现 npm 脚本找不到 `node` 时，见 [开发说明](docs/DEVELOPMENT.md#windows-长-path-的临时绕法)。

## 单元测试：npm test

```bash
npm test
```

脚本先用 `scripts/build-tests.mjs` / esbuild 将测试打包到 `out-test/*.test.cjs`，再用 Node 自带的 `node --test` 运行，不需要安装插件或启动真实 VS Code。部分测试会启动本机 HTTP 服务或真实子进程；VS Code API 由测试宿主替代。

| 测试文件 | 基线数量 | 覆盖内容 |
|---|---:|---|
| `test/route.test.ts` | 10 | 自动跟随、无焦点记录的兜底、锁定、目标离线不改投、多开拒绝猜、10 秒心跳过期边界、空窗口排除、工作区 key 规范化、共享文件原子写入及死窗口清理 |
| `test/hub.test.ts` | 16 | HTTP 转发及 502/503/404、请求发出时固定目标、SSE 消息跟随原会话、Hub 选举/接手/外部端口冲突、假隧道随 Hub 重启、跨窗口手动恢复；新增鉴权 health 隐私、7 种孤儿进程判断、接手/启动前核对及进程身份立即落盘 |
| `test/recovery.test.ts` | 9 | 首次启动、90 秒启动宽限、60 秒断开门槛、120→240→480→600 秒退避及复位、手动恢复至少间隔 30 秒、关闭及禁用自动恢复、假时钟/假隧道生命周期和启动失败重试 |
| `test/workspaceTools.test.ts` | 21 | ripgrep 与逐文件扫描两套引擎；overview、workspacePath 校验、目录/依赖/隐藏项/凭据过滤、真实路径防越界（含符号链接和 Windows 目录联接）、glob、大小写/正则、limit/行数/总量截断、Git 四种视图、rg 新旧布局定位 |
| `test/mcp.test.ts` | 6 | SDK Streamable HTTP / SSE 客户端经 Hub 调用、33 个工具及 annotations、锁定和旧 workspacePath 拒绝、裸 JSON-RPC、Bearer 鉴权、端口顺延/跳过 Hub/冲突；新增窗口 `/health` 和 `/` 动态开启鉴权后隐藏项目字段 |
| `test/diagnostics.test.ts` | 3 | 9 种分层自检分类、仅状态变化追加事件、面板地址及地址变化提示、Hub 状态过期显示 |
| `test/terminal.test.ts` | 2 | 真实终端写入/读取、UTF-8 中文 stdout/stderr、状态/PID、结束 PowerShell 及 Node 子进程树、结束后拒绝写入、启动命令和 dispose 回收；第二项仅 Windows 执行 |
| `test/orphanProcess.test.ts` | 1 | 只读取本测试 Node 进程的命令行，验证不会误认作 cloudflared；结束函数替换为失败断言 |
| **合计** | **68** | 原有 55 项 + 修复新增 13 项 |

`test/terminalHost.ts` 是终端测试用的 VS Code 接口替身，不单独计数。rg 测试取决于可用的 VS Code 自带 rg；没有 rg 时两套引擎的用例数可能不同，Git 不可用或非 Windows 环境也可能出现跳过。验收时同时记录通过、失败、跳过数量，不只看退出码。

孤儿回收测试使用假进程依赖；命令行读取测试只读自身进程。它们没有启动真实 cloudflared，也没有结束已有隧道。

## 隔离 VS Code 实测：npm run e2e

先准备与当前源码匹配的 VSIX（需要更新时先执行 `npm run package`），再在没有其他任务共用隔离目录时运行：

```bash
npm run e2e
```

脚本是 `scripts/e2e/isolated.mjs`，通过 `@vscode/test-electron` 获取独立的 stable VS Code。既有报告实测版本为 1.145.0；脚本未固定该版本，后续 stable 可能变化。

| 隔离项 | 路径 / 设置 |
|---|---|
| VS Code 程序缓存 | `.vscode-test/vscode/` |
| 用户数据 | `--user-data-dir=.vscode-test/user-data` |
| 扩展目录 | `--extensions-dir=.vscode-test/extensions`，CLI 安装仓库根目录的 VSIX |
| 测试项目 | `.vscode-test/projects/alpha`、`beta`，各有正常文件和 `.env` |
| 窗口端口 | `vsmcp.port=13333`，可顺延到 13337 |
| Hub 端口 | `vsmcp.hubPort=13340`，MCP 地址 `http://127.0.0.1:13340/mcp` |
| 共享文件 | `.vscode-test/user-data/User/globalStorage/yari.vsmcp/` |
| 外网 | `vsmcp.autoStartTunnel=false`，不启动真实公网隧道 |
| 结果 | `.vscode-test/e2e-result.json`，包含时间、逐项结果和状态 |

启动环境去掉继承的 `VSCODE_*`、`ELECTRON_*` 变量，再按 CLI 需要设置变量，避免命令转发到日常使用的 VS Code；同时关闭隔离实例的自动更新、遥测和工作区信任提示。不要同时跑两份 E2E，它们会共用目录和端口。

已有 **31 项**隔离实测覆盖这些步骤：

1. 两个窗口各有独立端口和 sessionId，只有一个 Hub；经 Hub `initialize`、列出 33 个工具及读写 annotations。
2. 自动跟随到 beta；`workspace_overview` 返回正确项目；增强工具搜不到/读不到 `.env`，正常源码可读。
3. 上游读取工具、`show_diff` 的 `vsmcp-preview:` 内存文件系统、终端命令可用；约 40 秒命令经过 Hub 不会被 35 秒超时截断。
4. 调命令打开侧栏，日志确认 webview 通过 CSP 并回复 ready；真实焦点切换能在 alpha/beta 之间自动跟随。
5. 锁定当前项目、切到其他窗口仍保持锁定、按 key 切锁定目标、恢复自动跟随；`/health` 显示模式和目标（未开启 authToken）。
6. SSE 的 endpoint 事件、`POST /messages` 和工具列表经 Hub 正常传递。
7. 锁定 Hub 所在项目后关闭该窗口，另一个窗口接手 13340；原目标离线返回 503，绝不改投；重开原项目恢复，Hub 不抢回。
8. 同一项目开两个窗口时返回 503，拒绝猜测。

正常收尾直接向各窗口端口发送退出命令；必要时脚本仅回收可执行文件位于本仓库 `.vscode-test` 的隔离进程。还应确认这些进程已退出、`windows/` 和 `hub.json` 清理、13333–13340 端口释放。共享目录被另一项隔离实测占用时不要运行 cleanup 或删除目录。

既有实测只确认面板加载和按钮对应的命令，**不等于人工点击和外观验收**。自动聚焦还可能受 Windows 防抢前台焦点机制影响。

## 手动端到端验收清单

在明确用于验收的 VS Code 环境中操作；不要未经同意卸载插件、修改日常配置或结束已有隧道。安装详细步骤见 [AGENTS.md](AGENTS.md)。

- [ ] 从 VSIX 安装 `yari.vsmcp`，重载窗口并打开一个测试项目；检查 VSMCP 侧栏及状态栏。
- [ ] 侧栏点击「开启外网」，确认项目 / Hub / 隧道 / 公网四层状态；复制以 `/mcp` 结尾的 ChatGPT 连接地址。
- [ ] 网页版 ChatGPT：插件 → 添加 → 添加自定义 MCP 服务器；连接选「服务器 URL」，填复制的地址；身份验证选「无身份验证 / No authentication」；勾选确认后「创建为插件」。账号未开放入口时记录为无法验收。
- [ ] 新开对话，输入 `@` 选中 VSMCP，发：「先调用 workspace_overview，告诉我现在打开的是哪个项目、根目录在哪。」人工核对结果后再试读写。
- [ ] 两窗口切换检查自动跟随；锁定后切窗口不改变目标；关闭锁定项目明确报错；同一项目多开明确拒绝。切换后重新调用 overview。
- [ ] 在可丢弃项目中人工确认面板按钮、深浅主题、差异预览、终端中文输出和停止进程树。
- [ ] 如需鉴权，在隔离配置中设置 `vsmcp.authToken`，验证 MCP 无 Bearer 被拒；匿名 `/health` 和 `/` 仍可访问，但不返回项目名/路径（Hub 仅有 status/service/instance，窗口仅 status/service）。这种设置需能填请求头的客户端，不能按上面的 ChatGPT 无鉴权方式连接。
- [ ] 用完点「关闭外网」；临时地址重开或换 Hub 后变化时更新 ChatGPT 插件地址。

公网真实重连、cloudflared metrics/ready、公网自检、winget 安装提示、令牌/命名隧道、localtunnel、上下文推送通知、macOS/Linux 及 VS Code 1.93–1.144 尚无上述报告中的完整实机验收证据，需按目标环境补测。外网地址默认就是访问钥匙，请勿公开。
