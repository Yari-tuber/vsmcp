/**
 * 分层自检（照原 diagnostics.js）：项目 → Hub → 隧道 → 公网，一层一层判断，
 * 不把「项目没打开」和「网络断了」混在一起。纯函数 + 一个写文件的记录器，单测覆盖。
 */
import * as fs from 'fs'
import type { RouteResult } from '../hub/route.js'
import type { TunnelRecord } from '../hub/registry.js'
import { writeJsonAtomic } from '../hub/registry.js'

export type LayerState = 'ok' | 'warn' | 'error' | 'off' | 'checking'
export type HubStatus = 'self' | 'other' | 'none' | 'foreign'

export interface DiagnosisInput {
  route: RouteResult
  hub: HubStatus
  hubPort: number
  tunnelWanted: boolean
  tunnel: TunnelRecord | null
  now: number
}

export interface Diagnosis {
  code:
    | 'hub_missing'
    | 'workspace_unavailable'
    | 'tunnel_off'
    | 'tunnel_starting'
    | 'tunnel_error'
    | 'tunnel_disconnected'
    | 'public_probe_failed'
    | 'checking_public'
    | 'healthy'
  level: 'ok' | 'info' | 'warning' | 'error'
  message: string
  action: string
  layers: { workspace: LayerState; hub: LayerState; tunnel: LayerState; public: LayerState }
}

export function classify(input: DiagnosisInput): Diagnosis {
  const { route, hub, tunnel, tunnelWanted, now } = input
  const workspace: LayerState = route.target ? 'ok' : 'warn'
  const hubLayer: LayerState = hub === 'self' || hub === 'other' ? 'ok' : hub === 'foreign' ? 'error' : 'checking'
  const phase = tunnelWanted ? tunnel?.phase ?? 'starting' : 'off'
  const tunnelLayer: LayerState =
    phase === 'off' ? 'off' : phase === 'connected' ? 'ok' : phase === 'starting' ? 'checking' : 'error'
  const probe = tunnel?.publicProbe ?? null
  const probeFresh = !!probe && now - probe.at < 120_000
  const publicLayer: LayerState =
    phase !== 'connected' ? (phase === 'off' ? 'off' : 'checking') : !probeFresh ? 'checking' : probe!.ok ? 'ok' : 'warn'
  const layers = { workspace, hub: hubLayer, tunnel: tunnelLayer, public: publicLayer }

  if (hub === 'foreign') {
    return {
      code: 'hub_missing',
      level: 'error',
      message: `没有窗口当上 Hub：端口 ${input.hubPort} 被别的程序占着`,
      action: `点「诊断」看是哪个程序占了 ${input.hubPort}，关掉它；或者在设置里把 vsmcp.hubPort 换成别的端口。`,
      layers,
    }
  }
  if (!route.target) {
    return {
      code: 'workspace_unavailable',
      level: 'warning',
      message: route.reason ?? '给 AI 的项目不在线',
      action: '打开锁定的项目，或在面板里明确选另一个项目；不会自动改投。',
      layers,
    }
  }
  if (phase === 'off') {
    return {
      code: 'tunnel_off',
      level: 'info',
      message: '本机一切正常，外网没开',
      action: '要给网页版 ChatGPT 用，点「开启外网」。',
      layers,
    }
  }
  if (phase === 'starting') {
    return { code: 'tunnel_starting', level: 'info', message: '正在建立外网隧道…', action: '一般十几秒，地址出来会显示在上面。', layers }
  }
  if (phase === 'error') {
    const missing = tunnel?.errorCode === 'cloudflared_missing'
    return {
      code: 'tunnel_error',
      level: 'error',
      message: tunnel?.lastError ? `外网开不起来：${tunnel.lastError}` : '外网开不起来',
      action: missing
        ? '点「安装 cloudflared」一键安装，装好后点「恢复连接」；也可以在设置里把 vsmcp.tunnelProvider 换成 localtunnel（不用装）。'
        : '检查网络 / 代理或隧道设置后点「恢复连接」；会按退避间隔自动重试。',
      layers,
    }
  }
  if (phase === 'disconnected') {
    return {
      code: 'tunnel_disconnected',
      level: 'error',
      message: '本机项目正常，但外网隧道没有可用连接',
      action: '断开满 60 秒会自动重建；网络一直不好时重试间隔会拉长（120 秒起翻倍，最长 10 分钟）。也可以点「恢复连接」。',
      layers,
    }
  }
  if (probeFresh && probe && !probe.ok) {
    return {
      code: 'public_probe_failed',
      level: 'warning',
      message: '隧道已连上，但从本机访问公网地址失败',
      action: '稍后自动复查。可能是本机代理、DNS 或公网侧的问题，不会自动改代理设置；ChatGPT 那边可能仍然连得上。',
      layers,
    }
  }
  if (!probeFresh) {
    return { code: 'checking_public', level: 'info', message: '本机和隧道正常，正在检查公网入口', action: '等这次自检结果。', layers }
  }
  return {
    code: 'healthy',
    level: 'ok',
    message: '项目、Hub、隧道、公网都正常',
    action: '可以在 ChatGPT 里用了；如果 ChatGPT 报 FORBIDDEN，检查那个会话的连接器权限。',
    layers,
  }
}

/** 写 diagnostics.json；状态变化时追加一行到 events.jsonl（超过 1 MB 轮转一次） */
export class DiagnosticsRecorder {
  private lastCode: string | null = null

  constructor(
    private readonly snapshotPath: string,
    private readonly eventsPath: string,
  ) {}

  record(diagnosis: Diagnosis, extra: Record<string, unknown> = {}): boolean {
    const data = { at: new Date().toISOString(), diagnosis, ...extra }
    let changed = false
    try {
      writeJsonAtomic(this.snapshotPath, data)
      if (this.lastCode !== diagnosis.code) {
        changed = true
        if (fs.existsSync(this.eventsPath) && fs.statSync(this.eventsPath).size > 1024 * 1024) {
          fs.renameSync(this.eventsPath, `${this.eventsPath}.previous`)
        }
        fs.appendFileSync(this.eventsPath, JSON.stringify(data) + '\n')
        this.lastCode = diagnosis.code
      }
    } catch {
      /* 写日志失败不影响主流程 */
    }
    return changed
  }
}
