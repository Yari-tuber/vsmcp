import * as vscode from 'vscode'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawn, execFileSync, type ChildProcess } from 'child_process'
import { log } from '../utils/logger.js'

const MAX_READ_SIZE = 128 * 1024 // Read last 128 KB from log file

interface ManagedTerminal {
  id: string
  name: string
  terminal: vscode.Terminal
  logFile: string
  cwd: string
  createdAt: number
  alive: boolean
  disposeListener: vscode.Disposable
  proc?: ChildProcess
}

export class TerminalManager {
  private terminals = new Map<string, ManagedTerminal>()
  private nextId = 1
  private logDir: string
  private baseDir: string

  constructor() {
    // 每个窗口（扩展宿主进程）一个子目录：多开窗口时互不删对方正在用的日志。
    // 目录名用 vsmcp-terminals，不碰上游插件的 vscode-mcp-terminals。
    this.baseDir = path.join(os.tmpdir(), 'vsmcp-terminals')
    this.logDir = path.join(this.baseDir, String(process.pid))
    fs.mkdirSync(this.logDir, { recursive: true })
    this.cleanupStaleLogDirs()
  }

  /** 只清理已经退出的窗口留下的日志目录 */
  private cleanupStaleLogDirs(): void {
    try {
      let removed = 0
      for (const name of fs.readdirSync(this.baseDir)) {
        const pid = Number(name)
        if (!Number.isInteger(pid) || pid === process.pid) continue
        let alive = false
        try {
          process.kill(pid, 0)
          alive = true
        } catch (err) {
          alive = (err as NodeJS.ErrnoException).code === 'EPERM'
        }
        if (alive) continue
        fs.rmSync(path.join(this.baseDir, name), { recursive: true, force: true })
        removed++
      }
      if (removed > 0) log.info('终端', `已清理 ${removed} 个已关闭窗口留下的终端日志目录`)
    } catch {
      // 清理失败不影响使用
    }
  }

  dispose(): void {
    for (const [, t] of this.terminals) {
      t.disposeListener.dispose()
      this.killProcessTree(t)
      t.terminal.dispose()
      this.cleanupLogFile(t.logFile)
    }
    this.terminals.clear()
  }

  spawn(name: string, command?: string, cwd?: string): { id: string; name: string } {
    const id = `term_${this.nextId++}`
    const workingDir = cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
    const logFile = path.join(this.logDir, `${id}.log`)
    const displayName = name || `任务 ${id}`

    // Launch script directly as the terminal shell so setup is invisible
    const isLinux = os.platform() === 'linux'
    const shell = process.env.SHELL || '/bin/zsh'

    // Use bash -c to set up trap and run script, which spawns the user's shell
    const setupCmd = isLinux
      ? `trap 'rm -f "${logFile}"' EXIT HUP TERM; script -q -f "${logFile}" -c "${shell}"`
      : `trap 'rm -f "${logFile}"' EXIT HUP TERM; script -q -F "${logFile}" "${shell}"`

    let proc: ChildProcess | undefined
    const terminal = process.platform === 'win32' ? (() => {
      const writeEmitter = new vscode.EventEmitter<string>()
      const closeEmitter = new vscode.EventEmitter<number>()
      const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
      proc = spawn(path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'],
        { cwd: workingDir, stdio: 'pipe', windowsHide: true })
      const child = proc
      let closed = false
      fs.writeFileSync(logFile, '')
      const feed = (text: string) => {
        if (closed) return
        fs.appendFileSync(logFile, text, 'utf8')
        writeEmitter.fire(text.replace(/\r?\n/g, '\r\n'))
      }
      child.stdout!.setEncoding('utf8').on('data', feed)
      child.stderr!.setEncoding('utf8').on('data', feed)
      child.stdin!.on('error', (err) => log.debug('终端', '终端输入已关闭', err.message))
      child.on('error', (err) => feed(`终端启动失败：${err.message}\n`))
      child.on('close', (code) => {
        closed = true
        const managed = this.terminals.get(id)
        if (managed) managed.alive = false
        closeEmitter.fire(code ?? 1)
      })
      // 第一行仅用 ASCII，先设编码，再读取后续的 UTF-8 中文命令。
      child.stdin!.write('[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false); [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $OutputEncoding = [Console]::OutputEncoding\n')
      const pty: vscode.Pseudoterminal = {
        onDidWrite: writeEmitter.event,
        onDidClose: closeEmitter.event,
        open: () => undefined,
        close: () => {
          closed = true
          const managed = this.terminals.get(id)
          if (managed) this.killProcessTree(managed)
          writeEmitter.dispose()
          closeEmitter.dispose()
        },
        handleInput: (data) => {
          if (!closed && child.stdin?.writable) child.stdin.write(data.replace(/\r\n|\r/g, '\n'))
        },
      }
      return vscode.window.createTerminal({ name: displayName, pty })
    })() : vscode.window.createTerminal({
      name: displayName,
      cwd: workingDir,
      shellPath: '/bin/bash',
      shellArgs: ['-c', setupCmd],
    })
    terminal.show(true)

    // If a command was provided, wait for the shell to be ready before sending
    if (command && !proc) {
      this.waitForReady(logFile, () => {
        terminal.sendText(command, true)
      })
    }

    // Listen for terminal close
    const disposeListener = vscode.window.onDidCloseTerminal((closed) => {
      if (closed === terminal) {
        const managed = this.terminals.get(id)
        if (managed) {
          managed.alive = false
          log.info('终端', `终端已关闭：${id}`)
          this.cleanupLogFile(managed.logFile)
        }
      }
    })

    const managed: ManagedTerminal = {
      id,
      name: displayName,
      terminal,
      logFile,
      cwd: workingDir,
      createdAt: Date.now(),
      alive: true,
      disposeListener,
      proc,
    }

    this.terminals.set(id, managed)
    if (command && proc) this.write(id, command)
    log.info('终端', `已创建终端：${id}（日志：${logFile}）`)

    return { id, name: displayName }
  }

  list(): Array<{
    id: string
    name: string
    alive: boolean
    cwd: string
    createdAt: number
    logSize: number
    pid?: number
  }> {
    return Array.from(this.terminals.values()).map(t => ({
      id: t.id,
      name: t.name,
      alive: t.alive,
      cwd: t.cwd,
      createdAt: t.createdAt,
      logSize: this.getLogSize(t.logFile),
      ...(t.proc?.pid ? { pid: t.proc.pid } : {}),
    }))
  }

  readOutput(id: string, lines?: number): { output: string; alive: boolean; totalBytes: number } | null {
    const managed = this.terminals.get(id)
    if (!managed) return null

    let output = ''
    let totalBytes = 0

    try {
      const stats = fs.statSync(managed.logFile)
      totalBytes = stats.size

      if (totalBytes === 0) {
        return { output: '', alive: managed.alive, totalBytes: 0 }
      }

      // Read the last MAX_READ_SIZE bytes
      const readSize = Math.min(totalBytes, MAX_READ_SIZE)
      const buffer = Buffer.alloc(readSize)
      const fd = fs.openSync(managed.logFile, 'r')
      fs.readSync(fd, buffer, 0, readSize, totalBytes - readSize)
      fs.closeSync(fd)

      output = this.stripAnsi(buffer.toString('utf-8'))

      if (lines !== undefined && lines > 0) {
        const allLines = output.split('\n')
        output = allLines.slice(-lines).join('\n')
      }
    } catch (err) {
      log.debug('终端', `无法读取终端 ${id} 的日志`, (err as Error).message)
    }

    return { output, alive: managed.alive, totalBytes }
  }

  write(id: string, input: string, addNewline = true): boolean {
    const managed = this.terminals.get(id)
    if (!managed || !managed.alive) return false
    if (managed.proc) {
      if (!managed.proc.stdin?.writable) return false
      managed.proc.stdin.write(input + (addNewline ? '\n' : ''))
    } else managed.terminal.sendText(input, addNewline)
    return true
  }

  kill(id: string, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    const managed = this.terminals.get(id)
    if (!managed) return false

    log.info('终端', `正在终止终端：${id}`)

    if (managed.proc) {
      this.killProcessTree(managed)
      managed.alive = false
      managed.disposeListener.dispose()
      managed.terminal.dispose()
      this.terminals.delete(id)
      this.cleanupLogFile(managed.logFile)
      return true
    }

    // Send exit to the script session, then dispose the terminal
    if (managed.alive) {
      managed.terminal.sendText('exit', true)
      // Give script a moment to clean up, then force dispose
      setTimeout(() => {
        managed.terminal.dispose()
        this.cleanupLogFile(managed.logFile)
      }, 1000)
      managed.alive = false
    }

    managed.disposeListener.dispose()
    this.terminals.delete(id)
    return true
  }

  private killProcessTree(managed: ManagedTerminal): void {
    const proc = managed.proc
    if (!managed.alive || !proc?.pid || proc.exitCode !== null || proc.signalCode !== null) return
    // 仅结束本管理器创建并持有句柄的进程树，绝不按进程名批量清理。
    execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/T', '/F', '/PID', String(proc.pid)], { windowsHide: true, stdio: 'pipe', timeout: 5000 })
    managed.alive = false
  }

  // Poll the log file until content appears (shell has started), then fire callback
  private waitForReady(logFile: string, callback: () => void, attempt = 0): void {
    const maxAttempts = 50 // 50 * 100ms = 5s max wait
    setTimeout(() => {
      if (this.getLogSize(logFile) > 0) {
        callback()
      } else if (attempt < maxAttempts) {
        this.waitForReady(logFile, callback, attempt + 1)
      } else {
        log.warn('终端', `Shell 在 5 秒内未就绪，仍将发送命令`)
        callback()
      }
    }, 100)
  }

  private getLogSize(logFile: string): number {
    try {
      return fs.statSync(logFile).size
    } catch {
      return 0
    }
  }

  private cleanupLogFile(logFile: string): void {
    try {
      fs.unlinkSync(logFile)
      log.debug('终端', `已清理日志文件：${logFile}`)
    } catch {
      // File may already be cleaned up by trap
    }
  }

  // Strip ANSI escape sequences and control characters from terminal output
  private stripAnsi(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>]|\x08.|\r/g, '')
  }
}
