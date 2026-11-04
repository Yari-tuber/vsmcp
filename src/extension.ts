/**
 * VSMCP 入口。每个 VS Code 窗口：
 *   1. 起自己的 MCP 服务（127.0.0.1，3333 起找空闲口；33 个工具 = 上游 27 + 增强 6）
 *   2. 把自己登记到共享目录（globalStorage/windows/<sessionId>.json），每 3 秒心跳，获得焦点时更新 focus.json
 *   3. 每 3 秒抢一次 Hub 端口（3340）。抢到的窗口负责：转发到「AI 现在操作的项目」、跑外网隧道、断线自动恢复
 *   4. 侧栏面板 + 状态栏 + 命令
 */
import * as vscode from 'vscode'
import * as os from 'os'
import * as path from 'path'
import { exec } from 'child_process'
import { randomBytes } from 'crypto'
import { VsCodeBridge } from './bridge/VsCodeBridge.js'
import { ContextPusher } from './context/ContextPusher.js'
import { HttpServer, PortInUseError, findPortOwner } from './server/HttpServer.js'
import { TerminalManager } from './terminal/TerminalManager.js'
import {
  CloudflareTunnel,
  CloudflaredNotInstalledError,
  TunnelAbortedError,
  TunnelConfigError,
  resolveCloudflared,
} from './tunnel/CloudflareTunnel.js'
import { LocaltunnelTunnel, LocaltunnelUnavailableError } from './tunnel/LocaltunnelTunnel.js'
import type { ManagedTunnel, TunnelDescription, TunnelErrorInfo } from './tunnel/TunnelSupervisor.js'
import { Settings } from './config/Settings.js'
import { log } from './utils/logger.js'
import { SharedDir, HEARTBEAT_MS, workspaceKey, type WindowRecord, type TunnelRecord } from './hub/registry.js'
import { isOnline, type RouteResult } from './hub/route.js'
import { HubRuntime } from './hub/HubRuntime.js'
import { WorkspaceTools } from './tools/workspaceTools.js'
import { findBundledRipgrep } from './tools/ripgrep.js'
import { PanelProvider, type PanelMessage } from './ui/PanelProvider.js'
import { buildPanelState, mcpUrl, type PanelState } from './ui/panelState.js'
import { USAGE_PROMPT, VERIFY_PROMPT, keyPrompt } from './ui/prompts.js'
import type { Diagnosis } from './diagnostics/diagnostics.js'

const CLOUDFLARED_DOWNLOAD_PAGE = 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'
const CLOUDFLARED_DIRECT_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
const WINGET_INSTALL_CMD = 'winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements'

/**
 * 隧道令牌存在 VS Code 系统凭据库（SecretStorage），所有窗口共用。
 * 绝不写入 settings.json —— 用户设置会被 Settings Sync 同步、工作区设置会被 git 提交。
 */
const TUNNEL_TOKEN_SECRET_KEY = 'vsmcp.tunnelToken'
const ACKED_URL_KEY = 'vsmcp.ackedUrl'

/** 面板按钮能直接调用的命令 */
const PANEL_COMMANDS = new Set([
  'vsmcp.startTunnel',
  'vsmcp.stopTunnel',
  'vsmcp.toggleTunnel',
  'vsmcp.recover',
  'vsmcp.diagnose',
  'vsmcp.showLogs',
  'vsmcp.lockCurrent',
  'vsmcp.autoFollow',
  'vsmcp.setTunnelToken',
  'vsmcp.openSettings',
  'vsmcp.installCloudflared',
  'vsmcp.selectTarget',
])

function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(1))
  return p
}

interface View {
  now: number
  route: RouteResult
  windows: WindowRecord[]
  hub: ReturnType<HubRuntime['hubStatus']>
  tunnelWanted: boolean
  tunnel: TunnelRecord | null
  diagnosis: Diagnosis
}

class VsmcpWindow {
  private readonly output: vscode.OutputChannel
  private readonly settings = new Settings()
  private readonly bridge = new VsCodeBridge()
  private readonly pusher: ContextPusher
  private readonly terminals: TerminalManager
  private readonly shared: SharedDir
  private readonly workspaceTools: WorkspaceTools
  private readonly httpServer: HttpServer
  private readonly hub: HubRuntime
  private readonly panel: PanelProvider
  private readonly targetItem: vscode.StatusBarItem
  private readonly tunnelItem: vscode.StatusBarItem
  private readonly sessionId = vscode.env.sessionId
  private readonly rgPath: string | null
  private gitPath = 'git'
  private focusedAt = 0
  private tunnelToken = ''
  private timers: Array<ReturnType<typeof setInterval>> = []
  /** 本窗口刚点了「开启外网」，等地址出来弹通知 */
  private awaitingTunnel: { since: number } | null = null
  private lastSeenUrl: string | null = null
  private lastRouteText = ''
  private disposed = false

  constructor(private readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel('VSMCP')
    context.subscriptions.push(this.output)
    log.init(this.output, 'debug')

    this.shared = new SharedDir(context.globalStorageUri.fsPath)
    this.shared.ensure()
    this.pusher = new ContextPusher(this.bridge)
    this.terminals = new TerminalManager()
    this.rgPath = findBundledRipgrep(vscode.env.appRoot)
    this.workspaceTools = new WorkspaceTools({
      getRoots: () => this.folders(),
      workspaceName: () => vscode.workspace.name ?? null,
      rgPath: this.rgPath,
      gitPath: () => this.gitPath,
    })
    this.httpServer = new HttpServer(this.bridge, this.pusher, this.settings, this.terminals, this.workspaceTools, () => this.windowName())

    this.hub = new HubRuntime({
      shared: this.shared,
      sessionId: this.sessionId,
      windowName: () => this.windowName(),
      hubPort: () => this.settings.hubPort,
      version: __EXT_VERSION__,
      autoRecover: () => this.settings.autoRecover,
      tunnel: {
        createTunnel: () => this.createTunnel(),
        describe: () => this.describeTunnel(),
        classifyError: (err) => classifyTunnelError(err),
        onEvent: (ev) => {
          if (ev.type === 'up') this.refreshUi()
        },
      },
      beforeReconfigure: () => this.refreshTunnelToken(),
      log: (level, message) => log[level]('Hub', message),
    })

    this.panel = new PanelProvider(
      context.extensionUri,
      () => this.panelState(),
      (msg) => this.onPanelMessage(msg),
    )

    this.targetItem = vscode.window.createStatusBarItem('vsmcp.target', vscode.StatusBarAlignment.Right, 100)
    this.targetItem.name = 'VSMCP：AI 当前项目'
    this.targetItem.command = 'vsmcp.openPanel'
    this.tunnelItem = vscode.window.createStatusBarItem('vsmcp.tunnel', vscode.StatusBarAlignment.Right, 99)
    this.tunnelItem.name = 'VSMCP：外网'
    this.tunnelItem.command = 'vsmcp.toggleTunnel'
    context.subscriptions.push(this.targetItem, this.tunnelItem)
  }

  // ---------------------------------------------------------------- 启动 / 停止

  async activate(): Promise<void> {
    const ctx = this.context
    log.info('扩展', `VSMCP ${__EXT_VERSION__} 启动（会话 ${this.sessionId}，共享目录 ${this.shared.root}）`)
    log.info('扩展', this.rgPath ? `搜索用 VS Code 自带的 ripgrep：${this.rgPath}` : '没找到 VS Code 自带的 ripgrep，增强工具退回逐文件扫描')

    ctx.subscriptions.push(
      vscode.workspace.registerFileSystemProvider('vsmcp-preview', this.bridge.memFs, { isCaseSensitive: true, isReadonly: true }),
      vscode.window.registerWebviewViewProvider(PanelProvider.viewId, this.panel, { webviewOptions: { retainContextWhenHidden: false } }),
    )
    if (this.settings.enableContextPush) this.pusher.start()
    void this.resolveGitPath()
    await this.refreshTunnelToken()
    this.registerCommands()

    // 整个 VS Code 刚启动（没有别的在线窗口、隧道状态也不是刚刚写的）：外网开关回到设置里的默认值
    const now = Date.now()
    const others = this.shared.listWindows().filter((w) => w.sessionId !== this.sessionId && isOnline(w, now))
    const tunnelRec = this.shared.readTunnel()
    if (others.length === 0 && !(tunnelRec && now - tunnelRec.updatedAt < 60_000)) {
      this.shared.updateState({ tunnelWanted: this.settings.autoStartTunnel })
    }

    await this.startServer(false)

    ctx.subscriptions.push(
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) this.onFocus()
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.writeRecord()
        if (vscode.window.state.focused) this.onFocus()
        this.refreshUi()
      }),
      this.settings.onChange((e) => void this.onSettingsChanged(e)),
    )
    if (vscode.window.state.focused) this.onFocus()

    this.timers.push(setInterval(() => this.writeRecord(), HEARTBEAT_MS))
    this.timers.push(setInterval(() => this.refreshUi(), 2000))
    this.hub.start()
    this.refreshUi()
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    log.info('扩展', '窗口关闭，注销登记并释放 Hub')
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    this.shared.removeWindow(this.sessionId)
    await this.hub.stop().catch(() => undefined)
    this.terminals.dispose()
    this.pusher.stop()
    await this.httpServer.stop().catch(() => undefined)
  }

  // ---------------------------------------------------------------- 本窗口信息与登记

  private folders(): Array<{ name: string; path: string }> {
    return (vscode.workspace.workspaceFolders ?? [])
      .filter((f) => f.uri.scheme === 'file')
      .map((f) => ({ name: f.name, path: f.uri.fsPath }))
  }

  private windowName(): string {
    const folders = this.folders()
    return vscode.workspace.name ?? folders[0]?.name ?? '（空窗口）'
  }

  private selfKey(): string {
    return workspaceKey(this.folders())
  }

  private writeRecord(): void {
    if (this.disposed) return
    const port = this.httpServer.port
    if (port <= 0) {
      this.shared.removeWindow(this.sessionId)
      return
    }
    try {
      this.shared.writeWindow({
        sessionId: this.sessionId,
        pid: process.pid,
        port,
        name: this.windowName(),
        folders: this.folders(),
        key: this.selfKey(),
        focusedAt: this.focusedAt,
        updatedAt: Date.now(),
        version: __EXT_VERSION__,
      })
    } catch (err) {
      log.warn('登记', `写窗口登记失败：${(err as Error).message}`)
    }
  }

  private onFocus(): void {
    this.focusedAt = Date.now()
    this.writeRecord()
    const folders = this.folders()
    if (folders.length > 0 && this.httpServer.port > 0) {
      try {
        this.shared.writeFocus({ key: this.selfKey(), name: this.windowName(), sessionId: this.sessionId, at: this.focusedAt })
      } catch (err) {
        log.warn('登记', `写焦点记录失败：${(err as Error).message}`)
      }
    }
    this.refreshUi()
  }

  private async resolveGitPath(): Promise<void> {
    try {
      const ext = vscode.extensions.getExtension<{ getAPI(v: 1): { git: { path: string } } }>('vscode.git')
      if (!ext) return
      const exports = ext.isActive ? ext.exports : await ext.activate()
      const p = exports?.getAPI(1)?.git?.path
      if (p) this.gitPath = p
    } catch {
      /* 用 PATH 里的 git */
    }
  }

  // ---------------------------------------------------------------- 本窗口 MCP 服务

  private async startServer(notify: boolean): Promise<void> {
    if (this.httpServer.port > 0) return
    try {
      const port = await this.httpServer.start(this.settings.port, this.settings.portFallback, [this.settings.hubPort])
      this.writeRecord()
      if (notify) vscode.window.showInformationMessage(`VSMCP：本窗口 MCP 服务已启动（127.0.0.1:${port}）`)
    } catch (err) {
      log.error('服务器', '本窗口 MCP 服务启动失败', (err as Error).message)
      if (err instanceof PortInUseError) {
        const pick = await vscode.window.showErrorMessage(
          `VSMCP：本窗口 MCP 服务起不来：${err.message}。可以关掉多余的 VS Code 窗口，或在设置里换 vsmcp.port。`,
          '打开端口设置',
          '复制占用信息',
          '重试',
        )
        if (pick === '打开端口设置') await vscode.commands.executeCommand('workbench.action.openSettings', 'vsmcp.port')
        else if (pick === '复制占用信息') await vscode.env.clipboard.writeText(`端口 ${err.port} 被 ${err.owner} 占用（VSMCP）`)
        else if (pick === '重试') void this.startServer(true)
      } else {
        vscode.window.showErrorMessage(`VSMCP：本窗口 MCP 服务启动失败：${err}`)
      }
    }
    this.refreshUi()
  }

  private async stopServer(): Promise<void> {
    this.shared.removeWindow(this.sessionId)
    await this.httpServer.stop()
    this.refreshUi()
  }

  // ---------------------------------------------------------------- 隧道（只有 Hub 窗口真正跑）

  private async resolveTunnelToken(): Promise<string> {
    const fromSecret = (await this.context.secrets.get(TUNNEL_TOKEN_SECRET_KEY))?.trim()
    if (fromSecret) return fromSecret
    const file = this.settings.tunnelTokenFile.trim()
    if (!file) return ''
    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(expandHome(file)))
      return Buffer.from(raw).toString('utf-8').trim()
    } catch (err) {
      log.warn('隧道', `读取 vsmcp.tunnelTokenFile 失败（${file}）：${err}`)
      return ''
    }
  }

  private async refreshTunnelToken(): Promise<void> {
    this.tunnelToken = await this.resolveTunnelToken()
  }

  private resolveSubdomain(): string {
    const configured = this.settings.tunnelSubdomain.trim()
    if (configured) return configured
    const saved = this.shared.readSubdomain()
    if (saved) return saved
    const generated = `vsmcp-${randomBytes(5).toString('hex')}`
    this.shared.writeSubdomain(generated)
    log.info('隧道', `已生成固定的 localtunnel 子域名：${generated}（保存在共享目录，换 Hub、重启都不变）`)
    return generated
  }

  private describeTunnel(): TunnelDescription {
    if (this.settings.tunnelProvider === 'localtunnel') return { provider: 'localtunnel', kind: 'localtunnel', fixed: true }
    if (this.tunnelToken) return { provider: 'cloudflare', kind: 'token', fixed: true }
    if (this.settings.tunnelName.trim() && this.settings.tunnelHostname.trim()) return { provider: 'cloudflare', kind: 'named', fixed: true }
    return { provider: 'cloudflare', kind: 'quick', fixed: false }
  }

  private createTunnel(): ManagedTunnel {
    if (this.settings.tunnelProvider === 'localtunnel') {
      const t = new LocaltunnelTunnel()
      const subdomain = this.resolveSubdomain()
      return {
        get url() {
          return t.url
        },
        get running() {
          return t.running
        },
        start: (port) => t.start(port, subdomain),
        stop: () => t.stop(),
        dispose: () => t.dispose(),
      }
    }
    const t = new CloudflareTunnel()
    const opts = { name: this.settings.tunnelName, hostname: this.settings.tunnelHostname, token: this.tunnelToken }
    return {
      get url() {
        return t.url
      },
      get running() {
        return t.running
      },
      start: (port) => t.start(port, opts),
      stop: () => t.stop(),
      dispose: () => t.dispose(),
      readyConnections: () => t.readyConnections(),
    }
  }

  private async startTunnel(): Promise<void> {
    if (this.httpServer.port <= 0) await this.startServer(false)
    if (this.settings.tunnelProvider === 'cloudflare' && !resolveCloudflared()) {
      this.shared.updateState({ tunnelWanted: true })
      void this.hub.tick()
      await this.promptCloudflaredInstall()
      return
    }
    this.awaitingTunnel = { since: Date.now() }
    this.shared.updateState({ tunnelWanted: true })
    if (this.hub.isHub) void this.hub.tick()
    const hub = this.hub.hubStatus()
    vscode.window.setStatusBarMessage(
      hub.status === 'other' ? `VSMCP：正在开启外网（由「${hub.record?.name ?? 'Hub'}」窗口负责）…` : 'VSMCP：正在开启外网…',
      5000,
    )
    this.refreshUi()
  }

  private async stopTunnel(): Promise<void> {
    this.awaitingTunnel = null
    this.shared.updateState({ tunnelWanted: false })
    if (this.hub.isHub) await this.hub.tick()
    vscode.window.setStatusBarMessage('VSMCP：外网已关闭', 4000)
    this.refreshUi()
  }

  private async requestRecover(): Promise<void> {
    if (this.httpServer.port <= 0) await this.startServer(false)
    this.writeRecord()
    const state = this.shared.readState()
    if (state.tunnelWanted) {
      this.awaitingTunnel = { since: Date.now() }
      this.shared.updateState({ recoverRequestedAt: Date.now() })
    }
    await this.hub.tick()
    vscode.window.setStatusBarMessage(state.tunnelWanted ? 'VSMCP：正在恢复连接…' : 'VSMCP：已检查本机服务（外网没开）', 4000)
    this.refreshUi()
  }

  private promptCloudflaredInstall(): Thenable<void> {
    return vscode.window
      .showWarningMessage(
        '没找到 cloudflared，开不了外网。选一种安装方式（或者在设置里把 vsmcp.tunnelProvider 换成 localtunnel，不用装）：',
        '用 winget 自动安装',
        '复制安装命令',
        '复制直链下载地址',
        '打开下载页面',
      )
      .then(async (choice) => {
        if (!choice) return
        if (choice === '用 winget 自动安装') {
          const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'VSMCP：正在用 winget 安装 cloudflared（可能要几分钟）…' },
            () =>
              new Promise<{ ok: boolean; output: string }>((resolve) => {
                exec(WINGET_INSTALL_CMD, { timeout: 300_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
                  resolve({ ok: !err, output: `${stdout ?? ''}\n${stderr ?? ''}` }),
                )
              }),
          )
          if (result.ok) {
            vscode.window.showInformationMessage('cloudflared 装好了，正在开启外网…')
            await this.requestRecover()
          } else {
            const open = await vscode.window.showErrorMessage(`winget 安装失败：${result.output.trim().slice(-300) || '未知错误'}`, '打开下载页面')
            if (open) void vscode.env.openExternal(vscode.Uri.parse(CLOUDFLARED_DOWNLOAD_PAGE))
          }
        } else if (choice === '复制安装命令') {
          await vscode.env.clipboard.writeText(WINGET_INSTALL_CMD)
          vscode.window.showInformationMessage(`已复制安装命令，在 PowerShell 里运行，装好后点面板上的「恢复连接」：\n${WINGET_INSTALL_CMD}`)
        } else if (choice === '复制直链下载地址') {
          await vscode.env.clipboard.writeText(CLOUDFLARED_DIRECT_URL)
          vscode.window.showInformationMessage('已复制下载直链（cloudflared-windows-amd64.exe）。下载后放到 PATH 里或 C:\\Program Files\\cloudflared\\，再点「恢复连接」。')
        } else {
          void vscode.env.openExternal(vscode.Uri.parse(CLOUDFLARED_DOWNLOAD_PAGE))
        }
      })
  }

  // ---------------------------------------------------------------- 路由选择

  private lockKey(key: string): void {
    const route = this.hub.route()
    const w = route.online.find((x) => x.key === key)
    if (!w) {
      vscode.window.showErrorMessage('VSMCP：这个项目已经离线了，刷新后再试。')
      return
    }
    this.shared.updateState({ mode: 'manual', selected: key, selectedName: w.name })
    this.panel.toast(`已锁定「${w.name}」给 AI`)
    vscode.window.setStatusBarMessage(`VSMCP：已锁定「${w.name}」给 AI`, 4000)
    this.refreshUi()
  }

  private lockCurrent(): void {
    if (this.folders().length === 0) {
      vscode.window.showWarningMessage('VSMCP：这个窗口没有打开项目文件夹，没法锁定。')
      return
    }
    if (this.httpServer.port <= 0) {
      vscode.window.showWarningMessage('VSMCP：本窗口 MCP 服务没在运行，先「启动 / 恢复连接」。')
      return
    }
    this.writeRecord()
    this.shared.updateState({ mode: 'manual', selected: this.selfKey(), selectedName: this.windowName() })
    this.panel.toast(`已锁定「${this.windowName()}」给 AI`)
    vscode.window.setStatusBarMessage(`VSMCP：已锁定「${this.windowName()}」给 AI`, 4000)
    this.refreshUi()
  }

  private autoFollow(): void {
    this.shared.updateState({ mode: 'auto' })
    // 在本窗口点的「自动跟随」：本窗口就是最后点过的窗口
    this.onFocus()
    this.panel.toast('已切回自动跟随')
    vscode.window.setStatusBarMessage('VSMCP：AI 跟随最后点过的 VS Code 窗口', 4000)
  }

  private async selectTarget(): Promise<void> {
    const route = this.hub.route()
    type Item = vscode.QuickPickItem & { key?: string; auto?: boolean }
    const items: Item[] = [
      { label: '$(sync) 自动跟随', description: route.mode === 'auto' ? '当前' : '', detail: '跟着最后点过的 VS Code 窗口走', auto: true },
      ...route.online.map((w) => ({
        label: `$(folder) ${w.name}`,
        description: `${route.target?.sessionId === w.sessionId ? '✓ AI 在用 · ' : ''}端口 ${w.port}`,
        detail: w.folders.map((f) => f.path).join('  ·  '),
        key: w.key,
      })),
    ]
    const pick = await vscode.window.showQuickPick(items, { placeHolder: '选给 AI 的项目（选中即锁定）' })
    if (!pick) return
    if (pick.auto) this.autoFollow()
    else if (pick.key) this.lockKey(pick.key)
  }

  // ---------------------------------------------------------------- 状态汇总 / 界面

  private view(): View {
    const now = Date.now()
    const route = this.hub.route()
    const state = this.shared.readState()
    return {
      now,
      route,
      windows: route.online,
      hub: this.hub.hubStatus(),
      tunnelWanted: !!state.tunnelWanted,
      tunnel: this.shared.readTunnel(),
      diagnosis: this.hub.diagnose(),
    }
  }

  private panelState(v: View = this.view()): PanelState {
    return buildPanelState({
      version: __EXT_VERSION__,
      now: v.now,
      self: {
        sessionId: this.sessionId,
        name: this.windowName(),
        port: this.httpServer.port,
        hasFolders: this.folders().length > 0,
        agents: this.httpServer.connectionCount,
        key: this.selfKey(),
      },
      route: v.route,
      windows: v.windows,
      hub: v.hub,
      hubPort: this.settings.hubPort,
      tunnelWanted: v.tunnelWanted,
      tunnel: v.tunnel,
      tunnelDefaults: this.describeTunnel(),
      ackedUrl: this.context.globalState.get<string>(ACKED_URL_KEY) ?? null,
      diagnosis: v.diagnosis,
      authEnabled: !!this.settings.authToken,
      tokenSet: !!this.tunnelToken,
      ripgrep: !!this.rgPath,
    })
  }

  private refreshUi(): void {
    if (this.disposed) return
    let v: View
    try {
      v = this.view()
    } catch (err) {
      log.warn('界面', `读取状态失败：${(err as Error).message}`)
      return
    }
    const ps = this.panelState(v)

    // 状态栏：AI 当前项目
    const r = v.route
    if (r.target) {
      this.targetItem.text = `$(remote) GPT: ${r.target.name}${r.mode === 'manual' ? ' $(lock)' : ''}`
      this.targetItem.backgroundColor = undefined
    } else {
      this.targetItem.text = `$(warning) GPT: ${r.code === 'duplicate' ? '项目多开' : '没有目标'}`
      this.targetItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
    }
    const tip = new vscode.MarkdownString(undefined, true)
    tip.appendMarkdown(`**VSMCP** · ${r.mode === 'manual' ? '已锁定' : '自动跟随'}\n\n`)
    if (r.target) tip.appendMarkdown(`AI 现在操作：**${r.target.name}**  \n\`${r.target.folders.map((f) => f.path).join('`, `')}\`\n\n`)
    else tip.appendMarkdown(`${r.reason ?? ''}\n\n`)
    tip.appendMarkdown(`本窗口端口 ${this.httpServer.port || '未运行'} · Hub ${ps.hub.status === 'self' ? '本窗口' : ps.hub.name ?? '—'}\n\n点击打开控制台`)
    this.targetItem.tooltip = tip
    this.targetItem.show()

    // 状态栏：外网
    const t = ps.tunnel
    const icons = { off: '$(circle-slash)', starting: '$(sync~spin)', connected: '$(globe)', disconnected: '$(warning)', error: '$(error)' } as const
    this.tunnelItem.text = `${icons[t.phase]} 外网`
    this.tunnelItem.backgroundColor =
      t.phase === 'error' ? new vscode.ThemeColor('statusBarItem.errorBackground') : t.phase === 'disconnected' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined
    this.tunnelItem.tooltip =
      t.phase === 'off'
        ? '外网没开。点击一键开启（没装 cloudflared 会提示安装）。'
        : t.phase === 'connected'
          ? `外网已开启：${t.url}\n点击关闭`
          : t.phase === 'starting'
            ? '外网正在建立…（点击关闭）'
            : `${t.lastError ?? '外网暂时断开，会自动重建'}\n点击关闭`
    this.tunnelItem.show()

    // 路由变化写日志
    const routeText = r.target ? `目标 ${r.target.name}（端口 ${r.target.port}，${r.mode}）` : `没有目标：${r.reason}`
    if (routeText !== this.lastRouteText) {
      this.lastRouteText = routeText
      log.info('路由', routeText)
    }

    this.notifyTunnel(ps)
    this.panel.push()
  }

  /** 本窗口点了「开启外网」后，地址出来 / 出错时弹一次通知；临时地址变了时提醒（只在当前有焦点的窗口） */
  private notifyTunnel(ps: PanelState): void {
    const t = ps.tunnel
    if (this.awaitingTunnel) {
      if (t.phase === 'connected' && t.url) {
        this.awaitingTunnel = null
        const url = t.url
        void vscode.window.showInformationMessage(`VSMCP：外网已开启 ${url}`, '复制连接地址', '复制使用提示词').then(async (pick) => {
          if (pick === '复制连接地址') await this.copy('publicUrl')
          else if (pick === '复制使用提示词') await this.copy('usage')
        })
      } else if (t.phase === 'error') {
        this.awaitingTunnel = null
        if (t.errorCode === 'cloudflared_missing') void this.promptCloudflaredInstall()
        else void vscode.window.showErrorMessage(`VSMCP：外网开不起来：${t.lastError ?? '未知错误'}`, '恢复连接', '打开控制台').then((pick) => {
          if (pick === '恢复连接') void this.requestRecover()
          else if (pick === '打开控制台') void this.openPanel()
        })
      } else if (!t.wanted || Date.now() - this.awaitingTunnel.since > 120_000) {
        this.awaitingTunnel = null
      }
    }
    if (t.url && t.url !== this.lastSeenUrl) {
      const prev = this.lastSeenUrl
      this.lastSeenUrl = t.url
      if (prev && !t.fixed && vscode.window.state.focused && !this.awaitingTunnel) {
        void vscode.window
          .showWarningMessage(`VSMCP：外网地址变了（隧道重建了），ChatGPT 里的连接器要改成新地址：${t.url}`, '复制新地址')
          .then(async (pick) => {
            if (pick) await this.copy('publicUrl')
          })
      }
    }
  }

  private async openPanel(): Promise<void> {
    await vscode.commands.executeCommand('workbench.view.extension.vsmcp')
    try {
      await vscode.commands.executeCommand(`${PanelProvider.viewId}.focus`)
    } catch {
      /* 旧版本没有 .focus 命令 */
    }
    this.panel.push(true)
  }

  private publicMcpUrl(): string | null {
    const ps = this.panelState()
    return ps.tunnel.phase === 'connected' || ps.tunnel.phase === 'disconnected' ? ps.tunnel.url : null
  }

  private async copy(what: string): Promise<void> {
    let text: string | null = null
    let done = '已复制'
    const pub = this.publicMcpUrl()
    switch (what) {
      case 'publicUrl':
        if (!pub) {
          vscode.window.showWarningMessage('VSMCP：外网还没开好，先点「开启外网」。')
          return
        }
        text = pub
        done = '已复制 ChatGPT 连接地址'
        break
      case 'usage':
        text = USAGE_PROMPT
        done = '已复制使用提示词，贴到 ChatGPT 对话开头'
        break
      case 'verify':
        text = VERIFY_PROMPT
        done = '已复制验证提示词，回到 ChatGPT 选中 VSMCP 后发送'
        break
      case 'key':
        if (!pub) {
          vscode.window.showWarningMessage('VSMCP：外网还没开好，先点「开启外网」。')
          return
        }
        text = keyPrompt(pub)
        done = '已复制关键提示词（地址 + 使用指令）'
        break
      case 'localUrl':
        text = `http://127.0.0.1:${this.settings.hubPort}/mcp`
        done = '已复制本机地址（跟随 AI 当前项目）'
        break
      case 'windowUrl':
        if (this.httpServer.port <= 0) return
        text = `http://127.0.0.1:${this.httpServer.port}/mcp`
        done = '已复制本窗口直连地址'
        break
      default:
        return
    }
    await vscode.env.clipboard.writeText(text)
    this.panel.toast(done)
    if (!this.panel.visible) vscode.window.setStatusBarMessage(`VSMCP：${done}`, 4000)
  }

  private async onPanelMessage(msg: PanelMessage): Promise<void> {
    switch (msg?.type) {
      case 'run':
        if (msg.command && PANEL_COMMANDS.has(msg.command)) await vscode.commands.executeCommand(msg.command)
        break
      case 'copy':
        if (msg.what) await this.copy(msg.what)
        break
      case 'lock':
        if (msg.key) this.lockKey(msg.key)
        break
      case 'ackUrl': {
        const url = this.panelState().tunnel.url
        await this.context.globalState.update(ACKED_URL_KEY, url)
        break
      }
    }
  }

  private async diagnose(): Promise<void> {
    await this.hub.tick()
    const v = this.view()
    const ps = this.panelState(v)
    const d = v.diagnosis
    const details: Record<string, unknown> = {
      at: new Date().toISOString(),
      version: __EXT_VERSION__,
      diagnosis: d,
      route: { mode: v.route.mode, code: v.route.code, target: v.route.target?.name ?? null, reason: v.route.reason },
      windows: v.windows.map((w) => ({ name: w.name, port: w.port, key: w.key, pid: w.pid, heartbeatAgoMs: v.now - w.updatedAt })),
      hub: { status: v.hub.status, name: v.hub.record?.name ?? null, port: this.settings.hubPort },
      thisWindow: { sessionId: this.sessionId, port: this.httpServer.port, isHub: this.hub.isHub },
      tunnel: ps.tunnel,
      sharedDir: this.shared.root,
      ripgrep: this.rgPath,
    }
    if (v.hub.status === 'foreign') details.hubPortOwner = await findPortOwner(this.settings.hubPort)
    log.info('诊断', JSON.stringify(details, null, 2))
    this.output.show(true)
    const level = d.level === 'error' ? 'showErrorMessage' : d.level === 'warning' ? 'showWarningMessage' : 'showInformationMessage'
    void vscode.window[level](`VSMCP 自检：${d.message}。${d.action}`)
  }

  private async onSettingsChanged(e: vscode.ConfigurationChangeEvent): Promise<void> {
    if (e.affectsConfiguration('vsmcp.enableContextPush')) {
      this.pusher.stop()
      if (this.settings.enableContextPush) this.pusher.start()
    }
    if (e.affectsConfiguration('vsmcp.port') || e.affectsConfiguration('vsmcp.portFallback') || e.affectsConfiguration('vsmcp.hubPort')) {
      log.info('设置', '端口设置变了，重启本窗口 MCP 服务')
      await this.stopServer()
      await this.startServer(false)
      void this.hub.tick()
    }
    if (
      ['tunnelProvider', 'tunnelSubdomain', 'tunnelTokenFile', 'tunnelName', 'tunnelHostname'].some((k) => e.affectsConfiguration(`vsmcp.${k}`))
    ) {
      await this.refreshTunnelToken()
      if (this.hub.isHub) {
        log.info('设置', '隧道设置变了，按新配置重开隧道')
        await this.hub.reconfigureTunnel()
      }
    }
    this.refreshUi()
  }

  // ---------------------------------------------------------------- 命令

  private registerCommands(): void {
    const reg = (id: string, fn: (...args: unknown[]) => unknown) => this.context.subscriptions.push(vscode.commands.registerCommand(id, fn))
    reg('vsmcp.openPanel', () => this.openPanel())
    reg('vsmcp.startTunnel', () => this.startTunnel())
    reg('vsmcp.stopTunnel', () => this.stopTunnel())
    reg('vsmcp.toggleTunnel', () => (this.shared.readState().tunnelWanted ? this.stopTunnel() : this.startTunnel()))
    reg('vsmcp.copyPublicUrl', () => this.copy('publicUrl'))
    reg('vsmcp.copyUsagePrompt', () => this.copy('usage'))
    reg('vsmcp.copyVerifyPrompt', () => this.copy('verify'))
    reg('vsmcp.copyKeyPrompt', () => this.copy('key'))
    reg('vsmcp.copyLocalUrl', () => this.copy('localUrl'))
    reg('vsmcp.showTunnelUrl', async () => {
      const url = this.publicMcpUrl()
      if (!url) {
        vscode.window.showWarningMessage('VSMCP：外网还没开好：点状态栏「外网」或面板上的「开启外网」。')
        return
      }
      const picked = await vscode.window.showInputBox({
        value: url,
        prompt: '外网 MCP 地址（填进 ChatGPT「添加自定义 MCP 服务器」）——回车复制',
        ignoreFocusOut: true,
      })
      if (picked !== undefined) {
        await vscode.env.clipboard.writeText(picked)
        vscode.window.setStatusBarMessage(`VSMCP：已复制 ${picked}`, 4000)
      }
    })
    reg('vsmcp.lockCurrent', () => this.lockCurrent())
    reg('vsmcp.lock', (key) => {
      if (typeof key === 'string') this.lockKey(key)
      else return this.selectTarget()
    })
    reg('vsmcp.autoFollow', () => this.autoFollow())
    reg('vsmcp.selectTarget', () => this.selectTarget())
    reg('vsmcp.recover', () => this.requestRecover())
    reg('vsmcp.diagnose', () => this.diagnose())
    reg('vsmcp.showLogs', () => this.output.show(true))
    reg('vsmcp.refresh', async () => {
      await this.hub.tick()
      this.refreshUi()
      this.panel.push(true)
    })
    reg('vsmcp.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:yari.vsmcp'))
    reg('vsmcp.installCloudflared', () => this.promptCloudflaredInstall())
    reg('vsmcp.setTunnelToken', async () => {
      const value = await vscode.window.showInputBox({
        prompt: '粘贴隧道令牌（存进系统凭据库，不写进 settings.json；还要在设置里填 vsmcp.tunnelHostname）',
        placeHolder: 'eyJhIjoi…（留空回车 = 清除已保存的令牌）',
        password: true,
        ignoreFocusOut: true,
      })
      if (value === undefined) return
      const trimmed = value.trim()
      if (trimmed) await this.context.secrets.store(TUNNEL_TOKEN_SECRET_KEY, trimmed)
      else await this.context.secrets.delete(TUNNEL_TOKEN_SECRET_KEY)
      await this.refreshTunnelToken()
      this.shared.updateState({ tunnelConfigAt: Date.now() })
      void this.hub.tick()
      vscode.window.showInformationMessage(trimmed ? 'VSMCP：隧道令牌已存进系统凭据库。' : 'VSMCP：已清除隧道令牌。')
      this.refreshUi()
    })
    reg('vsmcp.clearTunnelToken', async () => {
      await this.context.secrets.delete(TUNNEL_TOKEN_SECRET_KEY)
      await this.refreshTunnelToken()
      this.shared.updateState({ tunnelConfigAt: Date.now() })
      void this.hub.tick()
      vscode.window.showInformationMessage('VSMCP：已清除系统凭据库里的隧道令牌。')
      this.refreshUi()
    })
    reg('vsmcp.start', () => this.startServer(true))
    reg('vsmcp.stop', async () => {
      await this.stopServer()
      vscode.window.showInformationMessage('VSMCP：本窗口 MCP 服务已停止（AI 不会再路由到这个窗口）。')
    })
    reg('vsmcp.restart', async () => {
      await this.stopServer()
      await this.startServer(true)
    })
    reg('vsmcp.showStatus', async () => {
      const ps = this.panelState()
      const items = [
        { label: '$(layout-sidebar-left) 打开控制台', id: 'panel' },
        { label: ps.tunnel.wanted ? '$(circle-slash) 关闭外网' : '$(globe) 开启外网', id: 'toggle' },
        ...(ps.tunnel.url ? [{ label: '$(copy) 复制 ChatGPT 连接地址', description: ps.tunnel.url, id: 'copyPublic' }] : []),
        { label: '$(comment-discussion) 复制使用提示词', id: 'usage' },
        { label: '$(folder) 选择给 AI 的项目', description: ps.route.target?.name ?? '没有目标', id: 'select' },
        { label: '$(copy) 复制本机地址', description: ps.local.hubUrl, id: 'local' },
        { label: '$(pulse) 连接自检', id: 'diagnose' },
        { label: this.httpServer.port > 0 ? '$(debug-stop) 停止本窗口 MCP 服务' : '$(play) 启动本窗口 MCP 服务', id: 'server' },
      ]
      const pick = await vscode.window.showQuickPick(items, { placeHolder: `VSMCP · 本窗口端口 ${this.httpServer.port || '未运行'} · ${ps.diagnosis.message}` })
      if (!pick) return
      const map: Record<string, string> = {
        panel: 'vsmcp.openPanel',
        toggle: 'vsmcp.toggleTunnel',
        copyPublic: 'vsmcp.copyPublicUrl',
        usage: 'vsmcp.copyUsagePrompt',
        select: 'vsmcp.selectTarget',
        local: 'vsmcp.copyLocalUrl',
        diagnose: 'vsmcp.diagnose',
        server: this.httpServer.port > 0 ? 'vsmcp.stop' : 'vsmcp.start',
      }
      await vscode.commands.executeCommand(map[pick.id])
    })
  }
}

export function classifyTunnelError(err: unknown): TunnelErrorInfo {
  if (err instanceof CloudflaredNotInstalledError) return { code: 'cloudflared_missing', message: '没装 cloudflared', blocking: true }
  if (err instanceof TunnelAbortedError || (err instanceof Error && err.message === '隧道已被主动停止')) {
    return { code: 'aborted', message: '隧道已被主动停止', blocking: false }
  }
  if (err instanceof TunnelConfigError) return { code: 'config', message: err.message, blocking: true }
  if (err instanceof LocaltunnelUnavailableError) {
    return { code: err.subdomainRejected ? 'subdomain_rejected' : 'start_failed', message: err.message.split('\n')[0], blocking: false }
  }
  return { code: 'start_failed', message: err instanceof Error ? err.message : String(err), blocking: false }
}

let instance: VsmcpWindow | undefined

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  instance = new VsmcpWindow(context)
  await instance.activate()
}

export async function deactivate(): Promise<void> {
  await instance?.dispose()
  instance = undefined
}
