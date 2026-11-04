/**
 * Hub：所有窗口里只有一个抢到 Hub 端口（默认 3340），外网隧道接在它上面。
 * 它不处理 MCP 本身，只把 /mcp、/sse、/messages 原样转发给「AI 现在操作的项目」所在窗口。
 *
 * - 每个请求到达时定一次目标，整个请求都发给那个窗口；中途切换项目不影响已经发出的写入。
 * - SSE：GET /sse 建立时记下 MCP 会话 → 窗口端口，后面的 POST /messages?sessionId=… 跟着同一个窗口走。
 * - 目标离线 / 多开时直接报错，不改投别的项目。
 * 不依赖 vscode，单测直接起真服务器测。
 */
import * as http from 'http'
import { randomBytes } from 'crypto'
import type { RouteResult } from './route.js'

export type HubLog = (level: 'info' | 'warn' | 'error', message: string) => void

export interface HubServerOptions {
  resolveRoute: () => RouteResult
  version: string
  /** /health 里附带的额外信息（Hub 窗口名等） */
  extraHealth?: () => Record<string, unknown>
  log?: HubLog
}

const SESSION_RE = /sessionId=([A-Za-z0-9_-]+)/

function sendJson(res: http.ServerResponse, code: number, data: unknown): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(data))
}

/** 放宽 HTTP 超时：长命令、长任务不被 Node 默认超时掐断 */
export function relaxTimeouts(server: http.Server): void {
  server.requestTimeout = 0
  server.headersTimeout = 120_000
  server.timeout = 0
  server.keepAliveTimeout = 65_000
}

export class HubServer {
  private server: http.Server | null = null
  /** MCP SSE 会话 → 窗口端口 */
  private readonly sseSessions = new Map<string, number>()
  private activeRequests = 0
  private _instance = ''
  private _port = 0

  constructor(private readonly opts: HubServerOptions) {}

  get listening(): boolean {
    return this.server !== null
  }

  get port(): number {
    return this._port
  }

  /** 每次当上 Hub 随机生成，公网自检用它确认隧道通到的就是自己 */
  get instance(): string {
    return this._instance
  }

  get sseCount(): number {
    return this.sseSessions.size
  }

  get inFlight(): number {
    return this.activeRequests
  }

  /** 抢 Hub 端口：抢到返回 true；被占用返回 false；别的错误照常抛出 */
  listen(port: number): Promise<boolean> {
    if (this.server) return Promise.resolve(true)
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.opts.log?.('error', `Hub 处理请求出错：${(err as Error).message}`)
        sendJson(res, 500, { error: 'Hub 内部错误' })
      })
    })
    relaxTimeouts(server)
    return new Promise<boolean>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening)
        if (err.code === 'EADDRINUSE' || err.code === 'EACCES') resolve(false)
        else reject(err)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        server.on('error', (err) => this.opts.log?.('error', `Hub 服务器错误：${err.message}`))
        this.server = server
        this._port = port
        this._instance = randomBytes(8).toString('hex')
        resolve(true)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '127.0.0.1')
    })
  }

  async close(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    this._port = 0
    this.sseSessions.clear()
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }

  health(): { code: number; body: Record<string, unknown> } {
    const route = this.opts.resolveRoute()
    return {
      code: route.target ? 200 : 503,
      body: {
        status: route.target ? 'ok' : 'no_workspace',
        service: 'vsmcp-hub',
        version: this.opts.version,
        instance: this._instance,
        mode: route.mode,
        workspace: route.target?.name ?? null,
        port: route.target?.port ?? null,
        code: route.code,
        error: route.reason,
        ...(this.opts.extraHealth?.() ?? {}),
      },
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const pathname = url.pathname

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      })
      res.end()
      return
    }

    if (pathname === '/health' || pathname === '/') {
      const { code, body } = this.health()
      res.setHeader('Access-Control-Allow-Origin', '*')
      sendJson(res, code, body)
      return
    }

    if (pathname.startsWith('/messages')) {
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const port = this.sseSessions.get(sessionId)
      if (!port) {
        sendJson(res, 404, { error: 'SSE 会话不存在（可能已经换了 Hub 或窗口关了），请重新连接。' })
        return
      }
      this.proxy(req, res, port, null)
      return
    }

    if (pathname !== '/mcp' && pathname !== '/sse') {
      sendJson(res, 404, { error: 'Not found' })
      return
    }

    // 请求到达时就定下目标，整个请求都发给它
    const route = this.opts.resolveRoute()
    if (!route.target) {
      sendJson(res, 503, { jsonrpc: '2.0', id: null, error: { code: -32001, message: route.reason ?? '没有可用的项目窗口' } })
      return
    }
    const port = route.target.port
    if (pathname === '/sse' && req.method === 'GET') {
      this.proxy(req, res, port, (sessionId) => {
        this.sseSessions.set(sessionId, port)
        res.on('close', () => this.sseSessions.delete(sessionId))
      })
      return
    }
    this.proxy(req, res, port, null)
  }

  private proxy(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    port: number,
    onSseSession: ((sessionId: string) => void) | null,
  ): void {
    this.activeRequests++
    let counted = true
    const done = () => {
      if (counted) {
        counted = false
        this.activeRequests--
      }
    }
    const headers = { ...req.headers, host: `127.0.0.1:${port}` }
    const upstream = http.request(
      { host: '127.0.0.1', port, path: req.url, method: req.method, headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        if (onSseSession) {
          let sniff = ''
          const onData = (chunk: Buffer) => {
            sniff += chunk.toString('utf8')
            const m = sniff.match(SESSION_RE)
            if (m) {
              up.removeListener('data', onData)
              onSseSession(m[1])
            } else if (sniff.length > 8192) {
              up.removeListener('data', onData)
            }
          }
          up.on('data', onData)
        }
        up.pipe(res)
        up.on('end', done)
      },
    )
    upstream.on('error', (err) => {
      done()
      this.opts.log?.('warn', `转发到窗口端口 ${port} 失败：${err.message}`)
      if (!res.headersSent) {
        sendJson(res, 502, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32002, message: `目标 VS Code 窗口（端口 ${port}）已断开；没有改投别的项目。请确认窗口还开着后重试。` },
        })
      } else {
        res.destroy()
      }
    })
    res.on('close', () => {
      done()
      upstream.destroy()
    })
    req.pipe(upstream)
  }
}

/**
 * Hub 抢占 / 接手：每个窗口每 3 秒试着监听 Hub 端口，抢到的就是 Hub。
 * Hub 窗口关掉后端口释放，其他窗口下一轮就能接手。
 */
export class HubElection {
  private timer: ReturnType<typeof setInterval> | null = null
  private _isHub = false
  private _busy = false
  private ticking: Promise<boolean> | null = null

  constructor(
    private readonly opts: {
      server: HubServer
      port: () => number
      intervalMs?: number
      onAcquire?: () => void | Promise<void>
      onRelease?: () => void | Promise<void>
      onTick?: (isHub: boolean) => void | Promise<void>
      log?: HubLog
    },
  ) {}

  get isHub(): boolean {
    return this._isHub
  }

  /** 上一轮没抢到（端口被别的窗口或别的程序占着） */
  get portBusy(): boolean {
    return this._busy
  }

  start(): void {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? 3000)
    this.timer.unref?.()
  }

  tick(): Promise<boolean> {
    if (this.ticking) return this.ticking
    this.ticking = this.doTick().finally(() => {
      this.ticking = null
    })
    return this.ticking
  }

  private async doTick(): Promise<boolean> {
    const wantPort = this.opts.port()
    if (this._isHub && this.opts.server.port !== wantPort) {
      // Hub 端口设置改了：先放掉旧端口
      await this.release()
    }
    if (!this._isHub) {
      try {
        const ok = await this.opts.server.listen(wantPort)
        this._busy = !ok
        if (ok) {
          this._isHub = true
          this.opts.log?.('info', `本窗口当上了 Hub（127.0.0.1:${wantPort}）`)
          await this.opts.onAcquire?.()
        }
      } catch (err) {
        this._busy = true
        this.opts.log?.('error', `监听 Hub 端口 ${wantPort} 失败：${(err as Error).message}`)
      }
    }
    try {
      await this.opts.onTick?.(this._isHub)
    } catch (err) {
      this.opts.log?.('error', `Hub 周期任务出错：${(err as Error).message}`)
    }
    return this._isHub
  }

  async release(): Promise<void> {
    if (!this._isHub) return
    this._isHub = false
    await this.opts.server.close()
    this.opts.log?.('info', '本窗口不再是 Hub')
    try {
      await this.opts.onRelease?.()
    } catch (err) {
      this.opts.log?.('error', `释放 Hub 时出错：${(err as Error).message}`)
    }
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.ticking) await this.ticking.catch(() => undefined)
    await this.release()
  }
}
