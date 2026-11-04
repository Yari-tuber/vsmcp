/**
 * 路由选择：一个公网地址 → 「AI 现在操作的项目」所在窗口（纯函数，单测覆盖）。
 *
 * 规则（照原 router.js）：
 * - 锁定（manual）：只认锁定的那个项目；它不在线就报错，不改投别的项目。
 * - 自动跟随（auto）：认最后获得焦点的「有项目的窗口」（focus.json）。那个窗口关了 / 崩了也报错，
 *   等用户点一下别的窗口再跟过去，不自己猜。还没有任何焦点记录时，用在线窗口里最近获得过焦点的。
 * - 同一个工作区开了几个窗口：拒绝猜，提示关掉重复的。
 * - 心跳 10 秒内的才算在线；没有项目文件夹的空窗口不当目标。
 */
import { ONLINE_TTL_MS, type FocusRecord, type RouteState, type WindowRecord } from './registry.js'

export type RouteCode = 'ok' | 'no_windows' | 'no_selection' | 'offline' | 'duplicate'

export interface RouteResult {
  code: RouteCode
  mode: 'auto' | 'manual'
  source: 'manual' | 'focus' | 'initial' | 'none'
  desired: string | null
  desiredName: string | null
  target: WindowRecord | null
  /** 在线且有项目的窗口（面板列表用） */
  online: WindowRecord[]
  /** 同一个 key 在线的窗口数（>1 即多开） */
  duplicates: number
  reason: string | null
}

export function isOnline(w: WindowRecord, now: number, ttl = ONLINE_TTL_MS): boolean {
  return now - w.updatedAt <= ttl && now - w.updatedAt >= -60_000
}

export function selectTarget(
  windows: ReadonlyArray<WindowRecord>,
  state: RouteState,
  focus: FocusRecord | null,
  now: number,
  ttl = ONLINE_TTL_MS,
): RouteResult {
  const online = windows
    .filter((w) => w.folders.length > 0 && isOnline(w, now, ttl))
    .sort((a, b) => b.focusedAt - a.focusedAt || a.name.localeCompare(b.name))

  let desired: string | null = null
  let desiredName: string | null = null
  let source: RouteResult['source'] = 'none'

  if (state.mode === 'manual' && state.selected) {
    desired = state.selected
    desiredName = state.selectedName ?? null
    source = 'manual'
  } else if (state.mode === 'auto') {
    if (focus?.key && focus.key !== '[]') {
      desired = focus.key
      desiredName = focus.name
      source = 'focus'
    } else if (online.length > 0) {
      desired = online[0].key
      desiredName = online[0].name
      source = 'initial'
    }
  }

  const mode = state.mode === 'manual' && state.selected ? 'manual' : 'auto'
  const base = { mode, source, desired, desiredName, online } as const

  if (!desired) {
    return {
      ...base,
      code: online.length === 0 ? 'no_windows' : 'no_selection',
      target: null,
      duplicates: 0,
      reason: online.length === 0
        ? '还没有打开项目的 VS Code 窗口。请先用 VS Code 打开一个项目文件夹。'
        : '还没选给 AI 的项目：点一下要给 AI 的 VS Code 窗口，或在面板里锁定一个项目。',
    }
  }

  const matches = online.filter((w) => w.key === desired)
  const name = desiredName ?? matches[0]?.name ?? '目标项目'
  if (matches.length === 1) {
    return { ...base, desiredName: matches[0].name, code: 'ok', target: matches[0], duplicates: 1, reason: null }
  }
  if (matches.length > 1) {
    return {
      ...base,
      code: 'duplicate',
      target: null,
      duplicates: matches.length,
      reason: `「${name}」同时开了 ${matches.length} 个窗口，没法判断用哪个。请关掉重复的窗口。`,
    }
  }
  return {
    ...base,
    code: 'offline',
    target: null,
    duplicates: 0,
    reason: mode === 'manual'
      ? `锁定的项目「${name}」现在没打开（不会改投别的项目）。请打开它，或在面板里换一个项目。`
      : `最后点过的项目「${name}」已关闭或没响应（不会改投别的项目）。请点一下要给 AI 的 VS Code 窗口。`,
  }
}
