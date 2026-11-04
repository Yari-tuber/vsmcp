import * as http from 'http'
import { execFile } from 'child_process'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { VsCodeBridge } from '../bridge/VsCodeBridge.js'
import type { ContextPusher } from '../context/ContextPusher.js'
import type { TerminalManager } from '../terminal/TerminalManager.js'
import { registerTools } from '../tools/index.js'
import type { WorkspaceTools } from '../tools/workspaceTools.js'
import type { Settings } from '../config/Settings.js'
import { relaxTimeouts } from '../hub/HubServer.js'
import { log } from '../utils/logger.js'

/** 每个窗口的 MCP 服务最多顺延几个端口（默认 3333–3337） */
export const WINDOW_PORT_SPAN = 5

const MCP_INSTRUCTIONS = `你已连接到一个实时运行的 VS Code（VSMCP）。这个地址背后可能有好几个 VS Code 窗口，请求会发给用户选定的「AI 现在操作的项目」。

开始之前：
- 先调用 workspace_overview，确认当前项目和根路径（workspacePath），不要沿用上个项目的路径。
- 之后的增强工具（list_directory、find_files、search_text、read_files、git_inspect）都要传这个 workspacePath；遇到「工作区已切换」就重新调用 workspace_overview。

看代码：
- 浏览目录用 list_directory，按文件名找用 find_files，跨文件搜内容用 search_text，一次读多个文件用 read_files。
- read_files 读磁盘上已保存的内容；用户未保存的编辑用 read_file 或 get_active_file。
- 要看用户正在看什么：get_active_file、get_selection；LSP 错误用 get_diagnostics。
- go_to_definition、find_references、get_document_symbols、search_workspace_symbols 比文本搜索更准。
- 查 Git 用 git_inspect（status / diff / staged / log），它只读。

改代码：
- 改之前先读相关文件；需要时先用 show_diff 让用户在 VS Code 里看差异，再 write_file / create_file。
- rename_symbol 是全工作区安全重命名，比查找替换更好。
- 改完再调 get_diagnostics 确认没有新错误，用 run_terminal_command 跑项目自己的测试。

命令和长期进程：
- run_terminal_command 适合会结束的命令（构建、测试、lint、安装），默认超时 2 分钟，可用 timeoutMs 调长。
- 开发服务器、watch、tail -f 这类长期进程用 spawn_terminal，之后用 read_terminal 看输出、write_terminal 输入、kill_terminal 结束。

只根据工具实际返回判断完成情况。`

interface SessionEntry {
  transport: SSEServerTransport
  unsubscribePush: () => void
}

/** 固定端口被占用：携带占用方信息，让上层提示用户处理，而不是悄悄换端口 */
export class PortInUseError extends Error {
  constructor(
    public readonly port: number,
    public readonly owner: string,
    public readonly lastPort: number = port,
  ) {
    super(lastPort > port ? `端口 ${port}–${lastPort} 都被占用了（${port} 被 ${owner} 占用）` : `端口 ${port} 已被 ${owner} 占用`)
    this.name = 'PortInUseError'
  }
}

/** 执行子进程并返回 stdout（失败返回 null，避免干扰主流程） */
function runCapture(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout)
    })
  })
}

/** 找出占用某端口的进程描述（尽力而为，失败返回「未知进程」） */
export async function findPortOwner(port: number): Promise<string> {
  try {
    if (process.platform === 'win32') {
      const netstat = await runCapture('netstat', ['-ano'])
      if (!netstat) return '未知进程'
      for (const line of netstat.split(/\r?\n/)) {
        const m = line.match(/\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i)
        if (m && Number(m[2]) === port) {
          const pid = m[3]
          const tasklist = await runCapture('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
          const name = tasklist?.split(',')[0]?.replace(/"/g, '') ?? ''
          return name ? `${name}（PID ${pid}）` : `PID ${pid}`
        }
      }
      return '未知进程'
    }
    // macOS / Linux
    const lsof = await runCapture('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN'])
    if (!lsof) return '未知进程'
    for (const line of lsof.split(/\r?\n/).slice(1)) {
      const m = line.match(/^\S+\s+(\d+)\s+(\S+)/)
      if (m) return `${m[2]}（PID ${m[1]}）`
    }
    return '未知进程'
  } catch {
    return '未知进程'
  }
}

export class HttpServer {
  private httpServer: http.Server
  private sessions = new Map<string, SessionEntry>()
  private actualPort = 0

  constructor(
    private bridge: VsCodeBridge,
    private pusher: ContextPusher,
    private settings: Settings,
    private terminalManager: TerminalManager,
    private workspaceTools: WorkspaceTools,
    private workspaceName: () => string | null = () => null,
  ) {
    this.httpServer = http.createServer(this.handleRequest.bind(this))
    relaxTimeouts(this.httpServer)
  }

  get connectionCount(): number {
    return this.sessions.size
  }

  get port(): number {
    return this.actualPort
  }

  /**
   * 启动本窗口的 MCP 服务。
   *
   * 多窗口时每个窗口要一个端口：从 preferredPort 起顺延（共 WINDOW_PORT_SPAN 个，默认 3333–3337），
   * 跳过 avoid 里的端口（Hub 端口）。fallback = false 时只用 preferredPort（单窗口固定地址）。
   * 每个端口先短重试几次，吸收窗口重载时旧扩展宿主还没退出的竞态。
   */
  async start(preferredPort: number, fallback = true, avoid: number[] = []): Promise<number> {
    const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
    const ports: number[] = []
    for (let p = preferredPort; ports.length < (fallback ? WINDOW_PORT_SPAN : 1) && p < preferredPort + 20; p++) {
      if (!avoid.includes(p)) ports.push(p)
    }
    for (let round = 0; round < 3; round++) {
      if (round > 0) await delay(300)
      for (const port of ports) {
        try {
          await this.listen(port)
          this.actualPort = port
          log.info('服务器', `本窗口 MCP 服务监听 127.0.0.1:${port}`)
          return port
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' && (err as NodeJS.ErrnoException).code !== 'EACCES') throw err
        }
      }
    }
    const owner = await findPortOwner(ports[0] ?? preferredPort)
    throw new PortInUseError(ports[0] ?? preferredPort, owner, ports[ports.length - 1] ?? preferredPort)
  }

  /** 在指定端口上监听（成功/失败均只结算一次） */
  private listen(port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.httpServer.removeListener('listening', onListening)
        reject(err)
      }
      const onListening = () => {
        this.httpServer.removeListener('error', onError)
        resolve()
      }
      this.httpServer.once('error', onError)
      this.httpServer.once('listening', onListening)
      this.httpServer.listen(port, '127.0.0.1')
    })
  }

  async stop(): Promise<void> {
    for (const [, session] of this.sessions) {
      session.unsubscribePush()
    }
    this.sessions.clear()
    if (!this.httpServer.listening) {
      this.actualPort = 0
      return
    }
    await new Promise<void>((resolve) => {
      this.httpServer.close(() => resolve())
      this.httpServer.closeAllConnections?.()
    })
    this.actualPort = 0
  }

  private checkAuth(req: http.IncomingMessage): boolean {
    const token = this.settings.authToken
    if (!token) return true
    const header = req.headers['authorization'] ?? ''
    return header === `Bearer ${token}`
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const pathname = (req.url ?? '/').split('?')[0]
    if (pathname === '/health' || pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'ok',
        service: 'vsmcp-window',
        version: __EXT_VERSION__,
        workspace: this.workspaceName(),
        connectedAgents: this.sessions.size,
        port: this.actualPort,
      }))
      return
    }

    if (!this.checkAuth(req)) {
      log.warn('服务器', `未授权的请求：${req.url}`)
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: '未授权' }))
      return
    }

    if (pathname === '/sse' && req.method === 'GET') {
      await this.handleSse(req, res)
      return
    }

    if (pathname.startsWith('/messages') && req.method === 'POST') {
      await this.handleMessages(req, res)
      return
    }

    if (pathname === '/mcp') {
      if (req.method === 'POST') {
        await this.handleMcp(req, res)
        return
      }
      // 无状态模式：不提供服务端推送流，也没有会话需要终止
      res.writeHead(405, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method Not Allowed：/mcp 仅支持 POST（无状态 Streamable HTTP）' },
        id: null,
      }))
      return
    }

    res.writeHead(404)
    res.end()
  }

  private async handleSse(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const transport = new SSEServerTransport('/messages', res)
    const sessionId = transport.sessionId

    // Create a new McpServer per connection (SDK design requires this)
    const mcpServer = this.createMcpServer()

    // Wire context push events, but gate on initialization
    let initialized = false
    const unsubscribePush = this.settings.enableContextPush
      ? this.pusher.onPush((type, payload) => {
          if (!initialized) return
          try {
            transport.send({
              jsonrpc: '2.0',
              method: 'notifications/message',
              params: {
                level: 'info',
                logger: 'vsmcp',
                data: { type, payload },
              },
            }).catch(() => undefined)
          } catch { /* connection may have closed */ }
        })
      : () => undefined

    this.sessions.set(sessionId, { transport, unsubscribePush })
    log.info('服务器', `SSE 会话已连接：${sessionId}（当前连接数：${this.sessions.size}）`)

    req.on('close', () => {
      const session = this.sessions.get(sessionId)
      if (session) {
        session.unsubscribePush()
        this.sessions.delete(sessionId)
        log.info('服务器', `SSE 会话已断开：${sessionId}（当前连接数：${this.sessions.size}）`)
      }
    })

    // Start connection — enable push notifications after a delay to allow handshake to complete
    setTimeout(() => { initialized = true }, 2000)
    await mcpServer.connect(transport)
  }

  private async handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let parsedBody: unknown
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
    } catch {
      log.warn('服务器', '/mcp 收到非法 JSON 请求体')
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: Invalid JSON' }, id: null }))
      return
    }

    // 无状态模式：每个请求独立 transport + McpServer，请求结束即销毁。
    // enableJsonResponse 强制 JSON 响应，不建立 SSE 流——可穿透缓冲长连接正文的网络环境（如部分 Cloudflare 隧道）。
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    const mcpServer = this.createMcpServer()
    res.on('close', () => {
      void transport.close().catch(() => undefined)
      void mcpServer.close().catch(() => undefined)
    })

    try {
      await mcpServer.connect(transport)
      await transport.handleRequest(req, res, parsedBody)
    } catch (err) {
      log.error('服务器', '/mcp 请求处理失败', err)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }))
      } else {
        res.end()
      }
    }
  }

  private async handleMessages(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url!, `http://localhost`)
    const sessionId = url.searchParams.get('sessionId') ?? ''
    const session = this.sessions.get(sessionId)

    if (!session) {
      log.warn('服务器', `未知会话的消息：${sessionId}`)
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: '会话不存在' }))
      return
    }

    await session.transport.handlePostMessage(req, res)
  }

  /** 每个连接/请求创建一个 McpServer 实例（SDK 设计要求），/sse 与 /mcp 共用同一套工具注册 */
  private createMcpServer(): McpServer {
    const mcpServer = new McpServer(
      { name: 'vsmcp', version: __EXT_VERSION__ },
      { instructions: MCP_INSTRUCTIONS },
    )
    registerTools(mcpServer, this.bridge, this.settings, this.terminalManager, this.workspaceTools)
    return mcpServer
  }
}
