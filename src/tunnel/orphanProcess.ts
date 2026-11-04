import { execFile } from 'child_process'
import * as path from 'path'
import { promisify } from 'util'
import { isPidAlive, type TunnelRecord } from '../hub/registry.js'

const run = promisify(execFile)
const system32 = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')

export interface OrphanProcessDeps {
  isAlive(pid: number): boolean
  readCommandLine(pid: number): Promise<string | null>
  terminate(pid: number): Promise<void>
}

export const orphanProcessDeps: OrphanProcessDeps = {
  isAlive: isPidAlive,
  async readCommandLine(pid) {
    const result = process.platform === 'win32'
      ? await run(path.join(system32(), 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); (Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ], { windowsHide: true, encoding: 'utf8', timeout: 5000 })
      : await run('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 })
    return result.stdout.trim() || null
  },
  async terminate(pid) {
    if (process.platform === 'win32') {
      await run(path.join(system32(), 'taskkill.exe'), ['/T', '/F', '/PID', String(pid)], { windowsHide: true, timeout: 5000 })
    } else process.kill(pid, 'SIGTERM')
  },
}

/** 必须是 cloudflared 可执行文件，并带有本 Hub 的精确 URL 或记录的 metrics 地址。 */
function matches(command: string, record: TunnelRecord, hubPort: number): boolean {
  const args = Array.from(command.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g), m => m[1] ?? m[2] ?? m[3])
  const exe = args.shift()?.replace(/\\/g, '/').split('/').pop()?.toLowerCase()
  if (exe !== 'cloudflared' && exe !== 'cloudflared.exe') return false
  if (!args.includes('tunnel')) return false
  const flag = (name: string) => {
    const at = args.indexOf(name)
    return at >= 0 ? args[at + 1] : args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1)
  }
  const metrics = record.metricsAddress
  if (metrics && /^127\.0\.0\.1:\d+$/.test(metrics) && flag('--metrics') === metrics) return true
  const url = flag('--url')
  return url === `http://127.0.0.1:${hubPort}` || url === `http://127.0.0.1:${hubPort}/`
}

export async function cleanupOrphanTunnel(
  record: TunnelRecord | null, hubPort: number, deps: OrphanProcessDeps = orphanProcessDeps,
): Promise<boolean> {
  const pid = record?.pid
  if (!record || record.provider !== 'cloudflare' || !Number.isSafeInteger(pid) || !pid || pid <= 0) return false
  if (!deps.isAlive(pid)) return false
  let command: string | null
  try { command = await deps.readCommandLine(pid) } catch { return false }
  if (!command || !matches(command, record, hubPort)) return false
  // 不输出命令行：令牌隧道的参数可能包含凭据。
  await deps.terminate(pid)
  return true
}
