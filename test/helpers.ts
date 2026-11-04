import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as http from 'http'
import type { WindowRecord } from '../src/hub/registry.js'
import { workspaceKey } from '../src/hub/registry.js'

export function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `vsmcp-${prefix}-`))
}

export function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true })
  } catch {
    /* 测试清理失败不影响结果 */
  }
}

export function win(name: string, port: number, opts: Partial<WindowRecord> = {}): WindowRecord {
  const folders = opts.folders ?? [{ name, path: `/proj/${name}` }]
  return {
    sessionId: opts.sessionId ?? `s-${name}-${port}`,
    pid: opts.pid ?? process.pid,
    port,
    name,
    folders,
    key: workspaceKey(folders),
    focusedAt: opts.focusedAt ?? 0,
    updatedAt: opts.updatedAt ?? Date.now(),
  }
}

/** 找一个空闲端口（测试用，避开 3333–3350） */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = http.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      const port = typeof a === 'object' && a ? a.port : 0
      s.close(() => resolve(port))
    })
  })
}

export function listen(server: http.Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const a = server.address()
      resolve(typeof a === 'object' && a ? a.port : port)
    })
  })
}

export function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections?.()
  })
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 5000, stepMs = 50): Promise<T> {
  const start = Date.now()
  let last: unknown
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch (err) {
      last = err
    }
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时${last ? `：${(last as Error).message}` : ''}`)
    await sleep(stepMs)
  }
}

export async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 不是 JSON */
  }
  return { status: res.status, json, text }
}
