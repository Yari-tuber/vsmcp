/**
 * 隧道看护：只在 Hub 窗口里跑。按共享状态里的「想不想开外网」开关隧道，
 * 断了按 recoveryPolicy 的退避策略自动重建，状态写进 tunnel.json 给所有窗口的面板看。
 * 不依赖 vscode：隧道实现通过 createTunnel 注入，单测用假隧道。
 */
import { decide, initialPolicyState, type PolicyState } from './recoveryPolicy.js'
import type { TunnelPhase, TunnelRecord } from '../hub/registry.js'

export interface ManagedTunnel {
  readonly processInfo?: { pid: number; startedAt: number; metricsAddress: string | null } | null
  readonly url: string | null
  readonly running: boolean
  start(port: number, onSpawn?: () => void): Promise<string>
  stop(): void
  dispose(): void
  /** cloudflared 的边缘连接数（metrics /ready）；拿不到返回 null */
  readyConnections?(): Promise<number | null>
}

export interface TunnelDescription {
  provider: 'cloudflare' | 'localtunnel'
  kind: 'quick' | 'token' | 'named' | 'localtunnel'
  fixed: boolean
}

export interface TunnelErrorInfo {
  /** cloudflared_missing / config / subdomain_rejected / start_failed / aborted */
  code: string
  message: string
  /** 自动重试也没用（没装 cloudflared、配置缺项），只等用户处理后手动恢复 */
  blocking: boolean
}

export type TunnelEvent =
  | { type: 'up'; url: string; previousUrl: string | null }
  | { type: 'error'; info: TunnelErrorInfo }
  | { type: 'restart'; reason: string }

export interface SupervisorDeps {
  beforeStart?(): Promise<void>
  onProcessStarted?(): void
  createTunnel(): ManagedTunnel
  describe(): TunnelDescription
  now?(): number
  probePublic?(url: string): Promise<{ ok: boolean; detail?: string }>
  classifyError?(err: unknown): TunnelErrorInfo
  log?(level: 'info' | 'warn' | 'error', message: string): void
  onEvent?(event: TunnelEvent): void
  /** 公网自检间隔（默认 30 秒） */
  probeIntervalMs?: number
}

export type SupervisorStatus = Omit<TunnelRecord, 'hubSessionId' | 'updatedAt'>

export class TunnelSupervisor {
  private wanted = false
  private autoRecover = true
  private manualPending = false
  private tunnel: ManagedTunnel | null = null
  private starting: Promise<void> | null = null
  private startedAt: number | null = null
  private everStarted = false
  private policy: PolicyState = initialPolicyState()
  private nextRetryAt: number | null = null
  private lastError: TunnelErrorInfo | null = null
  private restarts = 0
  private lastUrl: string | null = null
  private previousUrl: string | null = null
  private urlChangedAt: number | null = null
  private connections: number | null = null
  private connected = false
  private probe: { ok: boolean; at: number; detail?: string } | null = null
  private probeFailures = 0
  private probing = false
  private lastProbeAt = 0
  private desc: TunnelDescription
  private lastReason = ''

  constructor(private readonly deps: SupervisorDeps) {
    this.desc = deps.describe()
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  get isWanted(): boolean {
    return this.wanted
  }

  get isStarting(): boolean {
    return this.starting !== null
  }

  get currentUrl(): string | null {
    return this.tunnel?.running ? this.tunnel.url : null
  }

  setWanted(wanted: boolean): void {
    this.wanted = wanted
  }

  setAutoRecover(on: boolean): void {
    this.autoRecover = on
  }

  /**
   * 换了 Hub 时，新 Hub 从 tunnel.json 接过上一个地址：临时隧道重开后地址变了，面板能提示「地址变了」。
   */
  seedLastUrl(url: string | null | undefined): void {
    if (url && !this.lastUrl) this.lastUrl = url
  }

  /** 用户点了「恢复连接」：下一轮按手动规则（距上次重建至少 30 秒）重建 */
  requestManual(): void {
    this.manualPending = true
  }

  /** 隧道设置改了（换实现、换令牌）：停掉当前隧道，下一轮按新配置马上重开 */
  reconfigure(): void {
    this.stopTunnel()
    this.policy = initialPolicyState()
    this.lastError = null
    this.everStarted = false
    this.desc = this.deps.describe()
  }

  async tick(port: number): Promise<void> {
    const now = this.now()
    const alive = !!this.tunnel?.running
    if (alive && !this.starting) {
      await this.observe(now)
    } else if (!alive) {
      this.connected = false
      this.connections = null
    }

    const d = decide(
      {
        now,
        wanted: this.wanted,
        autoRecover: this.autoRecover,
        alive,
        starting: this.starting !== null,
        connected: this.connected,
        startedAt: this.startedAt,
        manualRequested: this.manualPending,
        blocked: !!this.lastError?.blocking,
      },
      this.policy,
    )
    this.policy = d.state
    this.nextRetryAt = d.nextRetryAt
    if (d.consumedManual) this.manualPending = false
    if (d.reason !== this.lastReason && d.action === 'none') {
      this.lastReason = d.reason
    }

    switch (d.action) {
      case 'stop':
        this.deps.log?.('info', `隧道：${d.reason}`)
        this.stopTunnel()
        this.lastError = null
        this.everStarted = false
        break
      case 'restart':
      case 'start':
        if (this.everStarted) {
          this.restarts++
          this.deps.log?.('warn', `隧道：${d.reason}（第 ${this.restarts} 次重建，下次冷却 ${Math.round(this.policy.cooldownMs / 1000)} 秒）`)
          this.deps.onEvent?.({ type: 'restart', reason: d.reason })
        } else {
          this.deps.log?.('info', `隧道：${d.reason}`)
        }
        this.stopTunnel()
        this.beginStart(port, now)
        break
      default:
        break
    }
  }

  private async observe(now: number): Promise<void> {
    const t = this.tunnel
    if (!t) return
    if (t.url && t.url !== this.lastUrl) this.noteUrl(t.url, now)
    let measured = false
    if (t.readyConnections) {
      try {
        const n = await t.readyConnections()
        if (n !== null) {
          this.connections = n
          this.connected = n > 0
          measured = true
        }
      } catch {
        /* metrics 拿不到就按进程和地址判断 */
      }
    }
    if (!measured) {
      this.connections = null
      // 没有连接数可查（localtunnel）：公网自检连续失败 3 次算断
      this.connected = !!t.url && this.probeFailures < 3
    }
    const interval = this.deps.probeIntervalMs ?? 30_000
    if (this.deps.probePublic && t.url && !this.probing && now - this.lastProbeAt >= interval) {
      this.lastProbeAt = now
      this.probing = true
      const url = t.url
      void this.deps
        .probePublic(url)
        .then(
          (r) => r,
          (err: unknown) => ({ ok: false, detail: (err as Error)?.message ?? String(err) }),
        )
        .then((r) => {
          if (this.tunnel !== t) return
          this.probe = { ok: r.ok, at: this.now(), detail: r.detail }
          this.probeFailures = r.ok ? 0 : this.probeFailures + 1
        })
        .finally(() => {
          this.probing = false
        })
    }
  }

  private noteUrl(url: string, now: number): string | null {
    const prev = this.lastUrl
    if (prev && prev !== url) {
      this.previousUrl = prev
      this.urlChangedAt = now
    }
    this.lastUrl = url
    return prev && prev !== url ? prev : null
  }

  private beginStart(port: number, now: number): void {
    const t = this.deps.createTunnel()
    this.desc = this.deps.describe()
    this.tunnel = t
    this.startedAt = now
    this.everStarted = true
    this.lastError = null
    this.connected = false
    this.connections = null
    this.probe = null
    this.probeFailures = 0
    this.lastProbeAt = 0
    const p: Promise<void> = (async () => {
      await this.deps.beforeStart?.()
      if (this.tunnel !== t) return null
      return t.start(port, () => this.deps.onProcessStarted?.())
    })().then(
      (url) => {
        if (this.tunnel !== t || !url) return
        const prev = this.noteUrl(url, this.now())
        this.connected = true
        this.deps.log?.('info', `隧道已建立：${url}`)
        this.deps.onEvent?.({ type: 'up', url, previousUrl: prev })
      },
      (err: unknown) => {
        if (this.tunnel !== t) return
        const info = this.classify(err)
        try {
          t.stop()
        } catch {
          /* 已经停了 */
        }
        this.tunnel = null
        this.startedAt = null
        if (info.code === 'aborted') return
        this.lastError = info
        this.deps.log?.('error', `隧道启动失败：${info.message}`)
        this.deps.onEvent?.({ type: 'error', info })
      },
    )
    this.starting = p
    void p.finally(() => {
      if (this.starting === p) this.starting = null
    })
  }

  private classify(err: unknown): TunnelErrorInfo {
    if (this.deps.classifyError) return this.deps.classifyError(err)
    return { code: 'start_failed', message: (err as Error)?.message ?? String(err), blocking: false }
  }

  private stopTunnel(): void {
    const t = this.tunnel
    this.tunnel = null
    this.starting = null
    this.startedAt = null
    this.connected = false
    this.connections = null
    if (t) {
      try {
        t.stop()
        t.dispose()
      } catch {
        /* 已经停了 */
      }
    }
  }

  /** 等进行中的启动结束（单测用） */
  async settle(): Promise<void> {
    if (this.starting) await this.starting.catch(() => undefined)
  }

  shutdown(): void {
    this.wanted = false
    this.stopTunnel()
    this.policy = initialPolicyState()
    this.everStarted = false
  }

  status(): SupervisorStatus {
    const alive = !!this.tunnel?.running
    let phase: TunnelPhase
    if (!this.wanted) phase = 'off'
    else if (this.starting) phase = 'starting'
    else if (!alive && this.lastError) phase = 'error'
    else if (alive && this.connected) phase = 'connected'
    else phase = 'disconnected'
    const url = alive && this.tunnel?.url ? this.tunnel.url : this.desc.fixed && this.wanted ? this.lastUrl : null
    return {
      pid: this.tunnel?.processInfo?.pid ?? null,
      processStartedAt: this.tunnel?.processInfo?.startedAt ?? null,
      metricsAddress: this.tunnel?.processInfo?.metricsAddress ?? null,
      phase,
      provider: this.desc.provider,
      kind: this.desc.kind,
      url,
      fixed: this.desc.fixed,
      previousUrl: this.previousUrl,
      urlChangedAt: this.urlChangedAt,
      startedAt: this.startedAt,
      connections: this.connections,
      lastError: this.lastError?.message ?? null,
      errorCode: this.lastError?.code ?? null,
      restarts: this.restarts,
      nextRetryAt: phase === 'connected' || phase === 'off' ? null : this.nextRetryAt,
      publicProbe: this.probe,
    }
  }
}
