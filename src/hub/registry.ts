/**
 * 共享目录登记（不依赖 vscode，方便单测）。
 *
 * 所有窗口共用一个目录（扩展的 globalStorageUri）：
 *   windows/<sessionId>.json  每个窗口一份，每 3 秒刷新心跳，关窗删掉
 *   state.json                路由选择 { mode, selected } + 外网开关，任何窗口都能写（原子写）
 *   focus.json                最后获得焦点的「有项目的窗口」，自动跟随按它走
 *   hub.json                  当前 Hub 是谁（Hub 窗口写）
 *   tunnel.json               外网隧道状态（Hub 窗口写，所有窗口的面板读）
 *   diagnostics.json / events.jsonl  分层自检结果和状态变化记录
 */
import * as fs from 'fs'
import * as path from 'path'

export const HEARTBEAT_MS = 3000
/** 心跳超过这个时间没刷新就算离线 */
export const ONLINE_TTL_MS = 10_000

export interface FolderInfo {
  name: string
  path: string
}

export interface WindowRecord {
  sessionId: string
  pid: number
  port: number
  name: string
  folders: FolderInfo[]
  key: string
  focusedAt: number
  updatedAt: number
  version?: string
}

export interface RouteState {
  mode: 'auto' | 'manual'
  /** 锁定的工作区 key（manual 模式下有效） */
  selected: string | null
  /** 锁定时顺手记下名字，离线时提示用得上 */
  selectedName?: string | null
  /** 用户是否想开外网（Hub 按它开关隧道） */
  tunnelWanted?: boolean
  /** 用户最近一次点「恢复连接」的时间，Hub 看到比上次处理过的新就手动重建 */
  recoverRequestedAt?: number
  /** 隧道配置（令牌等存在凭据库里、设置监听不到的）改了的时间，Hub 看到就按新配置重开 */
  tunnelConfigAt?: number
  updatedAt?: number
}

export interface FocusRecord {
  key: string
  name: string
  sessionId: string
  at: number
}

export interface HubRecord {
  sessionId: string
  pid: number
  port: number
  name: string
  since: number
  updatedAt: number
  /** 每次当上 Hub 随机生成，公网自检时用来确认隧道确实通到这个 Hub */
  instance: string
}

export type TunnelPhase = 'off' | 'starting' | 'connected' | 'disconnected' | 'error'

export interface TunnelRecord {
  phase: TunnelPhase
  provider: 'cloudflare' | 'localtunnel'
  kind: 'quick' | 'token' | 'named' | 'localtunnel'
  /** 公网根地址（不带 /mcp） */
  url: string | null
  /** 地址是不是固定的（令牌 / 命名隧道 / localtunnel 固定子域名） */
  fixed: boolean
  /** 上一个地址（临时隧道重建后地址会变） */
  previousUrl?: string | null
  urlChangedAt?: number | null
  startedAt?: number | null
  connections?: number | null
  lastError?: string | null
  errorCode?: string | null
  restarts: number
  nextRetryAt?: number | null
  publicProbe?: { ok: boolean; at: number; detail?: string } | null
  hubSessionId: string
  updatedAt: number
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** 工作区 key：所有根目录规范化后排序，同一组根目录 = 同一个项目 */
export function workspaceKey(folders: ReadonlyArray<{ path: string }>): string {
  return JSON.stringify(folders.map((f) => normalizePath(f.path)).sort())
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** 原子写：先写临时文件再改名；Windows 上目标正被别人读时改名可能失败，短重试后退回直接写 */
export function writeJsonAtomic(file: string, data: unknown): void {
  const text = JSON.stringify(data, null, 2)
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, text, 'utf8')
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tmp, file)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break
      sleepSync(15 * (attempt + 1))
    }
  }
  try {
    fs.writeFileSync(file, text, 'utf8')
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* 已经改名成功或不存在 */
    }
  }
}

export function readJson<T>(file: string): T | null {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

const DEFAULT_STATE: RouteState = { mode: 'auto', selected: null, tunnelWanted: false }

export class SharedDir {
  readonly windowsDir: string
  readonly statePath: string
  readonly focusPath: string
  readonly hubPath: string
  readonly tunnelPath: string
  readonly diagnosticsPath: string
  readonly eventsPath: string
  readonly subdomainPath: string

  constructor(readonly root: string) {
    this.windowsDir = path.join(root, 'windows')
    this.statePath = path.join(root, 'state.json')
    this.focusPath = path.join(root, 'focus.json')
    this.hubPath = path.join(root, 'hub.json')
    this.tunnelPath = path.join(root, 'tunnel.json')
    this.diagnosticsPath = path.join(root, 'diagnostics.json')
    this.eventsPath = path.join(root, 'events.jsonl')
    this.subdomainPath = path.join(root, 'localtunnel-subdomain.txt')
  }

  ensure(): void {
    fs.mkdirSync(this.windowsDir, { recursive: true })
  }

  private windowFile(sessionId: string): string {
    return path.join(this.windowsDir, `${sessionId.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`)
  }

  writeWindow(rec: WindowRecord): void {
    writeJsonAtomic(this.windowFile(rec.sessionId), rec)
  }

  removeWindow(sessionId: string): void {
    try {
      fs.unlinkSync(this.windowFile(sessionId))
    } catch {
      /* 已经不在 */
    }
  }

  listWindows(): WindowRecord[] {
    let names: string[] = []
    try {
      names = fs.readdirSync(this.windowsDir)
    } catch {
      return []
    }
    const out: WindowRecord[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const rec = readJson<WindowRecord>(path.join(this.windowsDir, name))
      if (rec && typeof rec.sessionId === 'string' && Array.isArray(rec.folders) && typeof rec.port === 'number') {
        out.push(rec)
      }
    }
    return out
  }

  /**
   * 清掉明显死掉的登记：进程已经不在且心跳过期，或者心跳停了一小时以上。
   * 崩溃窗口的焦点记录不在这里（在 focus.json），所以清理不会让自动跟随改投别的项目。
   */
  cleanupStale(now: number, isAlive: (pid: number) => boolean = isPidAlive): string[] {
    const removed: string[] = []
    for (const rec of this.listWindows()) {
      const age = now - rec.updatedAt
      if ((age > ONLINE_TTL_MS * 3 && !isAlive(rec.pid)) || age > 3_600_000) {
        this.removeWindow(rec.sessionId)
        removed.push(rec.sessionId)
      }
    }
    return removed
  }

  readState(): RouteState {
    const s = readJson<Partial<RouteState>>(this.statePath)
    if (!s) return { ...DEFAULT_STATE }
    return {
      ...DEFAULT_STATE,
      ...s,
      mode: s.mode === 'manual' ? 'manual' : 'auto',
      selected: typeof s.selected === 'string' ? s.selected : null,
    }
  }

  updateState(patch: Partial<RouteState>): RouteState {
    const next = { ...this.readState(), ...patch, updatedAt: Date.now() }
    writeJsonAtomic(this.statePath, next)
    return next
  }

  readFocus(): FocusRecord | null {
    const f = readJson<FocusRecord>(this.focusPath)
    return f && typeof f.key === 'string' ? f : null
  }

  writeFocus(rec: FocusRecord): void {
    writeJsonAtomic(this.focusPath, rec)
  }

  readHub(): HubRecord | null {
    return readJson<HubRecord>(this.hubPath)
  }

  writeHub(rec: HubRecord): void {
    writeJsonAtomic(this.hubPath, rec)
  }

  removeHubIf(sessionId: string): void {
    const cur = this.readHub()
    if (cur && cur.sessionId === sessionId) {
      try {
        fs.unlinkSync(this.hubPath)
      } catch {
        /* 已经不在 */
      }
    }
  }

  readTunnel(): TunnelRecord | null {
    return readJson<TunnelRecord>(this.tunnelPath)
  }

  writeTunnel(rec: TunnelRecord): void {
    writeJsonAtomic(this.tunnelPath, rec)
  }

  /** localtunnel 自动生成的子域名放共享目录，换了 Hub 也用同一个 */
  readSubdomain(): string {
    try {
      return fs.readFileSync(this.subdomainPath, 'utf8').trim()
    } catch {
      return ''
    }
  }

  writeSubdomain(value: string): void {
    fs.mkdirSync(this.root, { recursive: true })
    fs.writeFileSync(this.subdomainPath, value, 'utf8')
  }
}
