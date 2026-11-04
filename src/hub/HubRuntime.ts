/**
 * 每个窗口都跑一份 HubRuntime：每 3 秒抢一次 Hub 端口；抢到了就负责
 *   - 转发（HubServer）
 *   - 隧道（TunnelSupervisor：按 state.json 的 tunnelWanted 开关、断了自动恢复）
 *   - 写 hub.json / tunnel.json / diagnostics.json，清理死掉的窗口登记
 * Hub 窗口关掉后，别的窗口下一轮接手，隧道也跟着在新 Hub 上重开。
 * 不依赖 vscode，单测直接用。
 */
import { HubElection, HubServer, type HubLog } from './HubServer.js'
import { selectTarget, type RouteResult } from './route.js'
import { ONLINE_TTL_MS, type HubRecord, type SharedDir } from './registry.js'
import { TunnelSupervisor, type SupervisorDeps } from '../tunnel/TunnelSupervisor.js'
import { cleanupOrphanTunnel, type OrphanProcessDeps } from '../tunnel/orphanProcess.js'
import { classify, DiagnosticsRecorder, type Diagnosis, type HubStatus } from '../diagnostics/diagnostics.js'

export interface HubRuntimeOptions {
  shared: SharedDir
  sessionId: string
  pid?: number
  windowName: () => string
  hubPort: () => number
  version: string
  authToken?: () => string
  orphanProcesses?: OrphanProcessDeps
  autoRecover: () => boolean
  tunnel: Omit<SupervisorDeps, 'probePublic' | 'now' | 'log'>
  log: HubLog
  intervalMs?: number
  now?: () => number
  /** 隧道配置变了（state.tunnelConfigAt 更新）时，重开隧道之前先调用（比如重新读凭据库里的令牌） */
  beforeReconfigure?: () => Promise<void>
  /** 公网自检；默认用 fetch 访问 <公网地址>/health 并核对 Hub 实例号 */
  probePublic?: (url: string, instance: string) => Promise<{ ok: boolean; detail?: string }>
}

/** 默认公网自检：经过隧道访问自己的 /health，确认返回的是当前这个 Hub */
export async function defaultProbePublic(url: string, instance: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/health`, {
      signal: AbortSignal.timeout(8000),
      headers: { 'bypass-tunnel-reminder': '1', 'User-Agent': 'vsmcp-selfcheck' },
    })
    const text = await res.text()
    let body: { service?: string; instance?: string } = {}
    try {
      body = JSON.parse(text)
    } catch {
      return { ok: false, detail: `公网返回的不是 VSMCP（HTTP ${res.status}）` }
    }
    if (body.service !== 'vsmcp-hub') return { ok: false, detail: `公网返回的不是 VSMCP（HTTP ${res.status}）` }
    if (instance && body.instance !== instance) return { ok: false, detail: '公网地址通到的不是当前 Hub（可能是残留的旧隧道）' }
    return { ok: true }
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } }
    return { ok: false, detail: e.cause?.code ?? e.name ?? String(err) }
  }
}

export class HubRuntime {
  readonly server: HubServer
  readonly election: HubElection
  readonly supervisor: TunnelSupervisor
  private readonly recorder: DiagnosticsRecorder
  private since = 0
  private lastManualHandled = 0
  private lastConfigHandled = 0
  private lastDiagnosis: Diagnosis | null = null

  constructor(private readonly opts: HubRuntimeOptions) {
    const now = () => (opts.now ? opts.now() : Date.now())
    this.server = new HubServer({
      resolveRoute: () => this.route(),
      version: opts.version,
      authToken: opts.authToken,
      extraHealth: () => ({ hub: opts.windowName() }),
      log: opts.log,
    })
    this.supervisor = new TunnelSupervisor({
      ...opts.tunnel,
      now,
      log: opts.log,
      probePublic: (url) => (opts.probePublic ?? defaultProbePublic)(url, this.server.instance),
      beforeStart: () => this.cleanupOrphan(),
      onProcessStarted: () => this.writeTunnel(),
    })
    this.election = new HubElection({
      server: this.server,
      port: opts.hubPort,
      intervalMs: opts.intervalMs ?? 3000,
      onAcquire: () => this.onAcquire(),
      onRelease: () => this.onRelease(),
      onTick: (isHub) => this.onTick(isHub),
      log: opts.log,
    })
    this.recorder = new DiagnosticsRecorder(opts.shared.diagnosticsPath, opts.shared.eventsPath)
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  get isHub(): boolean {
    return this.election.isHub
  }

  route(): RouteResult {
    const s = this.opts.shared
    return selectTarget(s.listWindows(), s.readState(), s.readFocus(), this.now())
  }

  /** 从本窗口看，Hub 现在是谁 */
  hubStatus(): { status: HubStatus; record: HubRecord | null } {
    if (this.election.isHub) return { status: 'self', record: this.opts.shared.readHub() }
    const rec = this.opts.shared.readHub()
    const fresh = !!rec && this.now() - rec.updatedAt <= ONLINE_TTL_MS
    if (fresh) return { status: 'other', record: rec }
    if (this.election.portBusy) return { status: 'foreign', record: null }
    return { status: 'none', record: null }
  }

  diagnose(): Diagnosis {
    const s = this.opts.shared
    const state = s.readState()
    return classify({
      route: this.route(),
      hub: this.hubStatus().status,
      hubPort: this.opts.hubPort(),
      tunnelWanted: !!state.tunnelWanted,
      tunnel: s.readTunnel(),
      now: this.now(),
    })
  }

  get lastHubDiagnosis(): Diagnosis | null {
    return this.lastDiagnosis
  }

  start(): void {
    this.election.start()
  }

  /** 马上跑一轮（面板「恢复连接」、单测用） */
  tick(): Promise<boolean> {
    return this.election.tick()
  }

  async stop(): Promise<void> {
    // 先同步收尾：窗口关闭时扩展宿主不一定等得到异步部分跑完。
    // 隧道进程先杀掉（不留孤儿 cloudflared），hub.json 先删掉（别的窗口马上知道该接手了）
    if (this.election.isHub) {
      this.supervisor.shutdown()
      this.opts.shared.removeHubIf(this.opts.sessionId)
    }
    await this.election.stop()
  }

  /** 本窗口是 Hub 时按新配置重开隧道（设置变了时 extension.ts 也会直接调用） */
  async reconfigureTunnel(): Promise<void> {
    if (!this.election.isHub) return
    try {
      await this.opts.beforeReconfigure?.()
    } catch (err) {
      this.opts.log('warn', `刷新隧道配置失败：${(err as Error).message}`)
    }
    this.supervisor.reconfigure()
  }

  private writeHub(): void {
    const now = this.now()
    this.opts.shared.writeHub({
      sessionId: this.opts.sessionId,
      pid: this.opts.pid ?? process.pid,
      port: this.server.port,
      name: this.opts.windowName(),
      since: this.since,
      updatedAt: now,
      instance: this.server.instance,
    })
  }

  private async onAcquire(): Promise<void> {
    this.since = this.now()
    // 当上 Hub 之前积压的「恢复连接」请求不重放
    const st = this.opts.shared.readState()
    this.lastManualHandled = st.recoverRequestedAt ?? 0
    this.lastConfigHandled = st.tunnelConfigAt ?? 0
    const prevTunnel = this.opts.shared.readTunnel()
    this.supervisor.seedLastUrl(prevTunnel?.url ?? prevTunnel?.previousUrl)
    await this.cleanupOrphan()
    this.writeHub()
  }

  private async cleanupOrphan(): Promise<void> {
    const record = this.opts.shared.readTunnel()
    const killed = await cleanupOrphanTunnel(record, this.opts.hubPort(), this.opts.orphanProcesses)
    if (killed && record) {
      this.opts.log('info', `已结束核对匹配的旧隧道进程（PID ${record.pid}）`)
      this.opts.shared.writeTunnel({ ...record, pid: null, processStartedAt: null, metricsAddress: null, updatedAt: this.now() })
    }
  }

  private writeTunnel(): void {
    this.opts.shared.writeTunnel({ ...this.supervisor.status(), hubSessionId: this.opts.sessionId,
      hubPort: this.server.port, updatedAt: this.now() })
  }

  private onRelease(): void {
    this.supervisor.shutdown()
    const s = this.opts.shared
    s.removeHubIf(this.opts.sessionId)
    const cur = s.readTunnel()
    if (cur && cur.hubSessionId === this.opts.sessionId) {
      // 地址留在 previousUrl 里：接手的 Hub 重开临时隧道后能看出地址变了
      s.writeTunnel({ ...cur, phase: 'off', url: null, pid: null, processStartedAt: null, metricsAddress: null,
        previousUrl: cur.url ?? cur.previousUrl ?? null, hubSessionId: this.opts.sessionId, updatedAt: this.now() })
    }
  }

  private async onTick(isHub: boolean): Promise<void> {
    if (!isHub) return
    const s = this.opts.shared
    const now = this.now()
    this.writeHub()
    s.cleanupStale(now)
    const state = s.readState()
    this.supervisor.setWanted(!!state.tunnelWanted)
    this.supervisor.setAutoRecover(this.opts.autoRecover())
    if ((state.tunnelConfigAt ?? 0) > this.lastConfigHandled) {
      this.lastConfigHandled = state.tunnelConfigAt ?? 0
      await this.reconfigureTunnel()
    }
    const req = state.recoverRequestedAt ?? 0
    if (req > this.lastManualHandled) {
      this.lastManualHandled = req
      if (state.tunnelWanted) this.supervisor.requestManual()
    }
    await this.supervisor.tick(this.server.port)
    this.writeTunnel()
    const diagnosis = this.diagnose()
    const prev = this.lastDiagnosis?.code
    this.lastDiagnosis = diagnosis
    if (this.recorder.record(diagnosis, { hub: this.opts.windowName(), hubPort: this.server.port }) && prev !== undefined) {
      this.opts.log(diagnosis.level === 'error' ? 'error' : diagnosis.level === 'warning' ? 'warn' : 'info', `自检状态变化：${prev} → ${diagnosis.code}（${diagnosis.message}）`)
    }
  }
}
