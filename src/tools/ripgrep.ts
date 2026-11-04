/**
 * 找 VS Code 自带的 ripgrep，用户不用另装 rg。
 * 老版本在 node_modules(.asar.unpacked)/@vscode/ripgrep/bin/rg(.exe)，
 * 新版本（2026 起）在 node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/<平台>-<架构>/rg(.exe)。
 */
import * as fs from 'fs'
import * as path from 'path'

export function findBundledRipgrep(
  appRoot: string | undefined,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  if (!appRoot) return null
  const exe = platform === 'win32' ? 'rg.exe' : 'rg'
  const bases = ['node_modules.asar.unpacked', 'node_modules']
  const isFile = (p: string) => {
    try {
      return fs.statSync(p).isFile()
    } catch {
      return false
    }
  }
  const candidates: string[] = []
  for (const base of bases) {
    candidates.push(path.join(appRoot, base, '@vscode', 'ripgrep', 'bin', exe))
    candidates.push(path.join(appRoot, base, '@vscode', 'ripgrep-universal', 'bin', `${platform}-${arch}`, exe))
  }
  for (const c of candidates) if (isFile(c)) return c

  // 兜底：扫一遍 @vscode/ripgrep* 包的 bin 目录（只看一层子目录，优先当前平台）
  for (const base of bases) {
    const scope = path.join(appRoot, base, '@vscode')
    let pkgs: string[] = []
    try {
      pkgs = fs.readdirSync(scope).filter((n) => n.startsWith('ripgrep'))
    } catch {
      continue
    }
    for (const pkg of pkgs) {
      const bin = path.join(scope, pkg, 'bin')
      if (isFile(path.join(bin, exe))) return path.join(bin, exe)
      let subs: string[] = []
      try {
        subs = fs.readdirSync(bin)
      } catch {
        continue
      }
      subs.sort((a, b) => Number(b.startsWith(`${platform}-${arch}`)) - Number(a.startsWith(`${platform}-${arch}`)))
      for (const sub of subs) {
        if (!sub.startsWith(platform)) continue
        const p = path.join(bin, sub, exe)
        if (isFile(p)) return p
      }
    }
  }
  return null
}
