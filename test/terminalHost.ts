import { EventEmitter as NodeEmitter } from 'node:events'
import { spawn } from 'node:child_process'

export class EventEmitter<T> {
  private emitter = new NodeEmitter()
  event = (listener: (value: T) => void) => {
    this.emitter.on('event', listener)
    return { dispose: () => { this.emitter.off('event', listener) } }
  }
  fire(value: T): void { this.emitter.emit('event', value) }
  dispose(): void { this.emitter.removeAllListeners() }
}

const closed = new EventEmitter<any>()
export const workspace = { workspaceFolders: undefined }
export const window = {
  onDidCloseTerminal: closed.event,
  createTerminal(options: any) {
    const proc = options.pty ? null : spawn(options.shellPath, options.shellArgs, { cwd: options.cwd })
    proc?.on('error', () => closed.fire(terminal))
    proc?.on('exit', () => closed.fire(terminal))
    proc?.stdout?.resume()
    proc?.stderr?.resume()
    const terminal = {
      show: () => { options.pty?.open() },
      sendText: (text: string, newline: boolean) => {
        if (options.pty) options.pty.handleInput(text + (newline ? '\r' : ''))
        else proc?.stdin?.write(text + (newline ? '\n' : ''))
      },
      dispose: () => {
        options.pty?.close()
        proc?.kill()
        closed.fire(terminal)
      },
    }
    return terminal
  },
}
