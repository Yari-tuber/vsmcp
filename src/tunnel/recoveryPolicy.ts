/**
 * 隧道自动恢复的退避策略（纯函数，照原 health-policy.ps1 + Start-VsMcp.ps1）。
 *
 * - 刚启动 90 秒内不算断（cloudflared 建边缘连接要时间）
 * - 连续断开满 60 秒才重建
 * - 重建后的冷却：120 秒起，每重建一次翻倍，最长 600 秒；一旦连上就回到 120 秒
 * - 手动「恢复连接」：距上次重建至少 30 秒
 * - 进程直接退出（崩溃、网络失败）：没有「断开 60 秒」可等，冷却到了就重建
 */
export const POLICY = {
  startupGraceMs: 90_000,
  offlineMs: 60_000,
  cooldownInitialMs: 120_000,
  cooldownMaxMs: 600_000,
  manualMinMs: 30_000,
} as const

export interface PolicyState {
  cooldownMs: number
  /** 上次（重新）启动的时间；null = 这次开外网以来还没启动过 */
  lastRestartAt: number | null
  /** 进程活着但没连上，从什么时候开始的 */
  offlineSince: number | null
}

export interface Observation {
  now: number
  /** 用户想开外网 */
  wanted: boolean
  /** vsmcp.autoRecover */
  autoRecover: boolean
  /** 隧道进程 / 连接对象还在 */
  alive: boolean
  /** 正在建立（start 还没返回） */
  starting: boolean
  /** 有可用的边缘连接 */
  connected: boolean
  /** 当前进程启动时间 */
  startedAt: number | null
  /** 用户点了「恢复连接」且还没处理 */
  manualRequested: boolean
  /** 遇到不可自动恢复的错误（比如没装 cloudflared），只等手动 */
  blocked: boolean
}

export type Action = 'none' | 'start' | 'restart' | 'stop'

export interface Decision {
  action: Action
  state: PolicyState
  reason: string
  /** 下次可能自动重建的时间（面板显示「xx 秒后重试」） */
  nextRetryAt: number | null
  /** 这次决定是否消费了手动请求 */
  consumedManual: boolean
}

export function initialPolicyState(): PolicyState {
  return { cooldownMs: POLICY.cooldownInitialMs, lastRestartAt: null, offlineSince: null }
}

function grow(cooldownMs: number): number {
  return Math.min(POLICY.cooldownMaxMs, cooldownMs * 2)
}

export function decide(obs: Observation, st: PolicyState): Decision {
  const since = st.lastRestartAt === null ? Number.POSITIVE_INFINITY : obs.now - st.lastRestartAt
  const none = (reason: string, state: PolicyState = st, nextRetryAt: number | null = null): Decision => ({
    action: 'none',
    state,
    reason,
    nextRetryAt,
    consumedManual: false,
  })

  if (!obs.wanted) {
    if (obs.alive || obs.starting) {
      return { action: 'stop', state: initialPolicyState(), reason: '外网已关闭', nextRetryAt: null, consumedManual: obs.manualRequested }
    }
    return { ...none('外网未开启', initialPolicyState()), consumedManual: obs.manualRequested }
  }

  if (obs.starting) return none('正在建立')

  if (obs.manualRequested) {
    if (since >= POLICY.manualMinMs) {
      return {
        action: obs.alive ? 'restart' : 'start',
        state: { cooldownMs: grow(st.cooldownMs), lastRestartAt: obs.now, offlineSince: null },
        reason: '手动恢复',
        nextRetryAt: null,
        consumedManual: true,
      }
    }
    return none('手动恢复太频繁（两次至少隔 30 秒），稍后自动执行', st, (st.lastRestartAt ?? obs.now) + POLICY.manualMinMs)
  }

  if (!obs.alive) {
    if (st.lastRestartAt === null) {
      return {
        action: 'start',
        state: { ...st, lastRestartAt: obs.now, offlineSince: null },
        reason: '开启外网',
        nextRetryAt: null,
        consumedManual: false,
      }
    }
    if (obs.blocked) return none('需要先处理错误，再点「恢复连接」')
    if (!obs.autoRecover) return none('自动恢复已关闭（vsmcp.autoRecover）')
    if (since >= st.cooldownMs) {
      return {
        action: 'start',
        state: { cooldownMs: grow(st.cooldownMs), lastRestartAt: obs.now, offlineSince: null },
        reason: '隧道进程已退出，自动重建',
        nextRetryAt: null,
        consumedManual: false,
      }
    }
    return none('隧道已退出，冷却中', st, (st.lastRestartAt ?? obs.now) + st.cooldownMs)
  }

  if (obs.connected) {
    return none('已连接', { ...st, offlineSince: null, cooldownMs: POLICY.cooldownInitialMs })
  }

  const offlineSince = st.offlineSince ?? obs.now
  const next: PolicyState = { ...st, offlineSince }
  const uptime = obs.startedAt === null ? 0 : obs.now - obs.startedAt
  const offline = obs.now - offlineSince
  const retryAt = Math.max(
    (obs.startedAt ?? obs.now) + POLICY.startupGraceMs,
    offlineSince + POLICY.offlineMs,
    (st.lastRestartAt ?? 0) + st.cooldownMs,
  )
  if (!obs.autoRecover) return none('自动恢复已关闭（vsmcp.autoRecover）', next)
  if (uptime >= POLICY.startupGraceMs && offline >= POLICY.offlineMs && since >= st.cooldownMs) {
    return {
      action: 'restart',
      state: { cooldownMs: grow(st.cooldownMs), lastRestartAt: obs.now, offlineSince: null },
      reason: `断开 ${Math.round(offline / 1000)} 秒，自动重建`,
      nextRetryAt: null,
      consumedManual: false,
    }
  }
  return none('暂时断开，等待恢复', next, retryAt)
}
