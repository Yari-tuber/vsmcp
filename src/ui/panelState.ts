/**
 * 侧栏面板的数据（扩展 → media/panel.js 的 postMessage 内容）。
 * 渲染和数据分开：面板只认这个结构，media/panel-demo.html 用同样结构的假数据截图。
 * 不依赖 vscode。
 */
import type { Diagnosis, HubStatus } from '../diagnostics/diagnostics.js'
import type { RouteResult, RouteCode } from '../hub/route.js'
import type { HubRecord, TunnelPhase, TunnelRecord, WindowRecord } from '../hub/registry.js'

export interface PanelProject {
  key: string
  sessionId: string
  name: string
  path: string
  extraRoots: number
  port: number
  isTarget: boolean
  isSelf: boolean
  isHub: boolean
  duplicate: boolean
  focusedAt: number
}

export interface PanelState {
  version: string
  now: number
  self: { sessionId: string; name: string; port: number; hasFolders: boolean; isHub: boolean; agents: number; key: string }
  hub: { status: HubStatus; port: number; name: string | null; since: number | null }
  route: {
    mode: 'auto' | 'manual'
    code: RouteCode
    reason: string | null
    desiredName: string | null
    target: { name: string; path: string; port: number; key: string; isSelf: boolean } | null
  }
  projects: PanelProject[]
  tunnel: {
    wanted: boolean
    phase: TunnelPhase
    provider: 'cloudflare' | 'localtunnel'
    kind: 'quick' | 'token' | 'named' | 'localtunnel'
    fixed: boolean
    /** 填进 ChatGPT 的完整地址（带 /mcp） */
    url: string | null
    urlChanged: boolean
    lastError: string | null
    errorCode: string | null
    restarts: number
    nextRetryAt: number | null
    connections: number | null
    startedAt: number | null
    probe: { ok: boolean; at: number; detail?: string } | null
  }
  local: { windowUrl: string | null; hubUrl: string }
  diagnosis: Diagnosis
  auth: { enabled: boolean }
  tokenSet: boolean
  search: 'ripgrep' | 'scan'
}

export interface PanelInputs {
  version: string
  now: number
  self: { sessionId: string; name: string; port: number; hasFolders: boolean; agents: number; key: string }
  route: RouteResult
  windows: WindowRecord[]
  hub: { status: HubStatus; record: HubRecord | null }
  hubPort: number
  tunnelWanted: boolean
  tunnel: TunnelRecord | null
  /** 本机配置推断出来的隧道类型（Hub 还没写 tunnel.json 时用） */
  tunnelDefaults: { provider: 'cloudflare' | 'localtunnel'; kind: 'quick' | 'token' | 'named' | 'localtunnel'; fixed: boolean }
  ackedUrl: string | null
  diagnosis: Diagnosis
  authEnabled: boolean
  tokenSet: boolean
  ripgrep: boolean
}

export function mcpUrl(base: string | null | undefined): string | null {
  if (!base) return null
  return `${base.replace(/\/+$/, '')}/mcp`
}

export function buildPanelState(i: PanelInputs): PanelState {
  const hubSession = i.hub.record?.sessionId ?? (i.hub.status === 'self' ? i.self.sessionId : null)
  const counts = new Map<string, number>()
  for (const w of i.route.online) counts.set(w.key, (counts.get(w.key) ?? 0) + 1)
  const projects: PanelProject[] = i.route.online.map((w) => ({
    key: w.key,
    sessionId: w.sessionId,
    name: w.name,
    path: w.folders[0]?.path ?? '',
    extraRoots: Math.max(0, w.folders.length - 1),
    port: w.port,
    isTarget: i.route.target?.sessionId === w.sessionId,
    isSelf: w.sessionId === i.self.sessionId,
    isHub: w.sessionId === hubSession,
    duplicate: (counts.get(w.key) ?? 0) > 1,
    focusedAt: w.focusedAt,
  }))
  const t = i.tunnel
  // tunnel.json 是 Hub 写的；Hub 刚换、还没写时按「想不想开」先显示「正在建立」
  const fresh = !!t && i.now - t.updatedAt <= 15_000
  const phase: TunnelPhase = !i.tunnelWanted ? 'off' : fresh && t ? (t.phase === 'off' ? 'starting' : t.phase) : 'starting'
  const url = phase === 'off' || !fresh ? null : mcpUrl(t?.url)
  const target = i.route.target
  return {
    version: i.version,
    now: i.now,
    self: { ...i.self, isHub: i.hub.status === 'self' },
    hub: { status: i.hub.status, port: i.hubPort, name: i.hub.record?.name ?? null, since: i.hub.record?.since ?? null },
    route: {
      mode: i.route.mode,
      code: i.route.code,
      reason: i.route.reason,
      desiredName: i.route.desiredName,
      target: target
        ? { name: target.name, path: target.folders[0]?.path ?? '', port: target.port, key: target.key, isSelf: target.sessionId === i.self.sessionId }
        : null,
    },
    projects,
    tunnel: {
      wanted: i.tunnelWanted,
      phase,
      provider: fresh && t ? t.provider : i.tunnelDefaults.provider,
      kind: fresh && t ? t.kind : i.tunnelDefaults.kind,
      fixed: fresh && t ? t.fixed : i.tunnelDefaults.fixed,
      url,
      urlChanged: !!url && !!t?.previousUrl && !!t.urlChangedAt && i.ackedUrl !== url,
      lastError: fresh ? t?.lastError ?? null : null,
      errorCode: fresh ? t?.errorCode ?? null : null,
      restarts: fresh ? t?.restarts ?? 0 : 0,
      nextRetryAt: fresh ? t?.nextRetryAt ?? null : null,
      connections: fresh ? t?.connections ?? null : null,
      startedAt: fresh ? t?.startedAt ?? null : null,
      probe: fresh ? t?.publicProbe ?? null : null,
    },
    local: {
      windowUrl: i.self.port > 0 ? `http://127.0.0.1:${i.self.port}/mcp` : null,
      hubUrl: `http://127.0.0.1:${i.hubPort}/mcp`,
    },
    diagnosis: i.diagnosis,
    auth: { enabled: i.authEnabled },
    tokenSet: i.tokenSet,
    search: i.ripgrep ? 'ripgrep' : 'scan',
  }
}
