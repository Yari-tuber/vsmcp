/**
 * 6 个增强工具（原 workspace-tools.js）：workspace_overview、list_directory、find_files、
 * search_text、read_files、git_inspect。
 *
 * - 全部只读；跳过依赖、构建产物和常见凭据文件（.env、私钥、credentials、secrets…）
 * - 路径先取真实路径（realpath）再判断是否在工作区里，符号链接 / 目录联接跳出去也拦得住
 * - 除 workspace_overview 外都要传 workspacePath，和本窗口的根目录对不上就报「工作区已切换」
 * - 搜索用 VS Code 自带的 ripgrep；找不到 rg 时退回逐文件扫描
 * 不依赖 vscode，单测直接调用。
 */
import { spawn } from 'child_process'
import * as fsp from 'fs/promises'
import * as path from 'path'

export interface WorkspaceRoot {
  name: string
  path: string
}

export interface WorkspaceToolsDeps {
  /** 本窗口当前的工作区根目录 */
  getRoots: () => WorkspaceRoot[]
  workspaceName: () => string | null
  /** VS Code 自带的 rg；null = 退回逐文件扫描 */
  rgPath: string | null
  /** git 可执行文件（VS Code Git 扩展找到的那个），默认 'git' */
  gitPath?: () => string
  /** 外部命令超时（毫秒），默认 20 秒 */
  timeoutMs?: number
}

export const WORKSPACE_TOOL_NAMES = [
  'workspace_overview',
  'list_directory',
  'find_files',
  'search_text',
  'read_files',
  'git_inspect',
] as const
export type WorkspaceToolName = (typeof WORKSPACE_TOOL_NAMES)[number]

const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', 'dist', 'build', '__pycache__', '.next', 'out', '.vscode-test'])
const MAX_OUTPUT = 2 * 1024 * 1024
const READ_BUDGET = 80_000

/** 常见凭据文件：.env*、私钥、credentials、secrets、*.pem/key/p12/pfx */
export function isSecretPath(p: string): boolean {
  return p
    .split(/[\\/]/)
    .some(
      (x) =>
        /^\.env(?:\.|$)/i.test(x) ||
        /^(?:id_rsa|id_ed25519|id_ecdsa|id_dsa|credentials(?:\..*)?|secrets?(?:\..*)?)$/i.test(x) ||
        /\.(pem|key|p12|pfx)$/i.test(x),
    )
}

export function isInside(root: string, p: string): boolean {
  const rel = path.relative(root, p)
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '')
}

function bounded(n: unknown, def: number, max: number): number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? Math.min(n, max) : def
}

const RG_EXCLUDES = [
  '!**/.git/**',
  '!**/node_modules/**',
  '!**/.venv/**',
  '!**/venv/**',
  '!**/dist/**',
  '!**/build/**',
  '!**/.env*',
  '!**/*.{pem,key,p12,pfx}',
  '!**/credentials*',
  '!**/secret*',
  '!**/id_rsa*',
  '!**/id_ed25519*',
].flatMap((x) => ['--glob', x])

/** 简单 glob → 正则（支持 ** * ? {a,b} [abc]），只给「没有 rg」的兜底用 */
export function globToRegExp(glob: string, ignoreCase = process.platform === 'win32'): RegExp {
  let re = ''
  let depth = 0
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else {
          re += '.*'
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') re += '[^/]'
    else if (c === '{') {
      re += '(?:'
      depth++
    } else if (c === '}' && depth > 0) {
      re += ')'
      depth--
    } else if (c === ',' && depth > 0) re += '|'
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1)
      if (end > i + 1) {
        let cls = glob.slice(i + 1, end)
        if (cls.startsWith('!')) cls = '^' + cls.slice(1)
        re += '[' + cls.replace(/\\/g, '\\\\') + ']'
        i = end
      } else re += '\\['
    } else if ('\\^$.|+()]'.includes(c)) re += '\\' + c
    else re += c
  }
  return new RegExp('^' + re + '$', ignoreCase ? 'i' : '')
}

/** 和 rg 的 --glob 一样：不带 / 的 glob 匹配文件名，带 / 的匹配相对路径 */
export function matchGlob(glob: string, relPath: string): boolean {
  const g = toPosix(glob).replace(/^\//, '')
  const rel = toPosix(relPath)
  if (!g.includes('/')) return globToRegExp(g).test(rel.split('/').pop() ?? rel)
  return globToRegExp(g).test(rel)
}

interface CommandResult {
  out: string
  truncated: boolean
}

function runCommand(exe: string, args: string[], cwd: string, accepted: number[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(exe, args, {
        cwd,
        shell: false,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
      })
    } catch (err) {
      reject(new Error(`无法运行 ${exe}：${(err as Error).message}`))
      return
    }
    const out: Buffer[] = []
    const errChunks: Buffer[] = []
    let size = 0
    let errSize = 0
    let truncated = false
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      proc.kill()
      finish(() => reject(new Error(`命令超时（${Math.round(timeoutMs / 1000)} 秒），请缩小范围。`)))
    }, timeoutMs)
    proc.on('error', (e) => finish(() => reject(new Error(`无法运行 ${exe}：${e.message}`))))
    proc.stdout?.on('data', (b: Buffer) => {
      if (truncated) return
      size += b.length
      if (size > MAX_OUTPUT) {
        truncated = true
        out.push(b.subarray(0, Math.max(0, b.length - (size - MAX_OUTPUT))))
        proc.kill()
        finish(() => resolve({ out: Buffer.concat(out).toString('utf8'), truncated: true }))
      } else out.push(b)
    })
    proc.stderr?.on('data', (b: Buffer) => {
      if (errSize < 8192) {
        errChunks.push(b)
        errSize += b.length
      }
    })
    proc.on('close', (code) => {
      finish(() => {
        if (!accepted.includes(code ?? -1)) {
          reject(new Error(Buffer.concat(errChunks).toString('utf8').slice(0, 1500) || `命令失败（退出码 ${code}）`))
        } else {
          resolve({ out: Buffer.concat(out).toString('utf8'), truncated })
        }
      })
    })
  })
}

export class WorkspaceTools {
  constructor(private readonly deps: WorkspaceToolsDeps) {}

  get usingRipgrep(): boolean {
    return !!this.deps.rgPath
  }

  private timeout(): number {
    return this.deps.timeoutMs ?? 20_000
  }

  private async realRoots(): Promise<WorkspaceRoot[]> {
    const roots = await Promise.all(
      this.deps.getRoots().map(async (f) => {
        try {
          return { name: f.name, path: await fsp.realpath(f.path) }
        } catch {
          return null
        }
      }),
    )
    return roots.filter((r): r is WorkspaceRoot => r !== null)
  }

  /** 解析工作区内的路径：取真实路径，跳出工作区（含符号链接）或是凭据文件就拒绝 */
  async resolveInside(root: string, p: unknown = '.'): Promise<string> {
    if (typeof p !== 'string') throw new Error('路径必须是字符串')
    let full: string
    try {
      full = await fsp.realpath(path.resolve(root, p))
    } catch {
      throw new Error(`路径不存在：${p}`)
    }
    if (!isInside(root, full)) throw new Error('路径超出当前工作区（包括符号链接）。')
    if (isSecretPath(path.relative(root, full))) throw new Error('常见凭据文件（.env、私钥等）不纳入增强工具。')
    return full
  }

  private async rootFor(workspacePath: unknown, roots: WorkspaceRoot[]): Promise<string> {
    if (typeof workspacePath !== 'string' || !workspacePath) {
      throw new Error('请先调用 workspace_overview，并把返回的 workspacePath 传进来。')
    }
    let requested: string
    try {
      requested = await fsp.realpath(workspacePath)
    } catch {
      throw new Error('工作区已切换，拒绝使用旧项目路径。请重新调用 workspace_overview。')
    }
    const hit = roots.find((r) => r.path.toLowerCase() === requested.toLowerCase())
    if (!hit) throw new Error('工作区已切换，拒绝使用旧项目路径。请重新调用 workspace_overview。')
    return hit.path
  }

  async tree(root: string, directory: unknown, depth: number, limit: number): Promise<{ entries: Array<{ path: string; type: string }>; truncated: boolean }> {
    const start = await this.resolveInside(root, directory ?? '.')
    const entries: Array<{ path: string; type: string }> = []
    let truncated = false
    const walk = async (dir: string, level: number): Promise<void> => {
      let list
      try {
        list = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      list.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      for (const x of list) {
        if (SKIP_DIRS.has(x.name) || x.name.startsWith('.') || isSecretPath(x.name)) continue
        if (entries.length >= limit) {
          truncated = true
          return
        }
        const p = path.join(dir, x.name)
        entries.push({
          path: toPosix(path.relative(root, p)),
          type: x.isSymbolicLink() ? 'link' : x.isDirectory() ? 'directory' : 'file',
        })
        if (x.isDirectory() && !x.isSymbolicLink() && level < depth) await walk(p, level + 1)
        if (truncated) return
      }
    }
    await walk(start, 1)
    return { entries, truncated }
  }

  /** 兜底遍历：不跟符号链接，跳过依赖 / 隐藏 / 凭据，最多 50000 个文件 */
  private async walkFiles(root: string, visit: (rel: string, full: string) => Promise<boolean> | boolean): Promise<boolean> {
    let count = 0
    const stack = [root]
    while (stack.length) {
      const dir = stack.pop()!
      let list
      try {
        list = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      list.sort((a, b) => a.name.localeCompare(b.name))
      const subdirs: string[] = []
      for (const x of list) {
        if (SKIP_DIRS.has(x.name) || x.name.startsWith('.') || isSecretPath(x.name) || x.isSymbolicLink()) continue
        const full = path.join(dir, x.name)
        if (x.isDirectory()) subdirs.push(full)
        else if (x.isFile()) {
          if (++count > 50_000) return true
          const keepGoing = await visit(toPosix(path.relative(root, full)), full)
          if (!keepGoing) return true
        }
      }
      stack.push(...subdirs.reverse())
    }
    return false
  }

  async findFiles(root: string, glob: unknown, limit: number): Promise<{ files: string[]; truncated: boolean; engine: string }> {
    if (typeof glob !== 'string' || !glob) throw new Error('glob 不能为空')
    if (this.deps.rgPath) {
      const r = await runCommand(this.deps.rgPath, ['--files', '--glob', glob, ...RG_EXCLUDES, '.'], root, [0, 1], this.timeout())
      const all = r.out
        .split(/\r?\n/)
        .filter(Boolean)
        .map(toPosix)
        .filter((x) => !isSecretPath(x))
        .sort()
      return { files: all.slice(0, limit), truncated: all.length > limit || r.truncated, engine: 'ripgrep' }
    }
    const files: string[] = []
    let more = await this.walkFiles(root, (rel) => {
      if (matchGlob(glob, rel)) files.push(rel)
      return files.length <= limit
    })
    if (files.length > limit) more = true
    return { files: files.slice(0, limit), truncated: more, engine: 'scan' }
  }

  async searchText(
    root: string,
    a: { query?: unknown; glob?: unknown; regex?: unknown; caseSensitive?: unknown },
    limit: number,
  ): Promise<{ matches: Array<{ path: string; line: number; text: string }>; truncated: boolean; note: string; engine: string }> {
    const query = a.query
    if (typeof query !== 'string' || !query || query.length > 2000 || query.includes('\n')) {
      throw new Error('请输入单行搜索词（1 至 2000 字符）')
    }
    const glob = typeof a.glob === 'string' && a.glob ? a.glob : null
    const matches: Array<{ path: string; line: number; text: string }> = []
    let truncated = false
    if (this.deps.rgPath) {
      const args = ['--json', '--max-count', '20', '--max-columns', '1000', '--max-filesize', '1M', ...RG_EXCLUDES]
      if (!a.regex) args.push('--fixed-strings')
      if (!a.caseSensitive) args.push('--ignore-case')
      if (glob) args.push('--glob', glob)
      args.push('--', query, '.')
      const r = await runCommand(this.deps.rgPath, args, root, [0, 1], this.timeout())
      truncated = r.truncated
      for (const line of r.out.split('\n')) {
        if (!line.trim()) continue
        let j: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } }
        try {
          j = JSON.parse(line)
        } catch {
          continue
        }
        if (j.type !== 'match' || !j.data?.path?.text) continue
        const rel = toPosix(j.data.path.text)
        if (isSecretPath(rel)) continue
        matches.push({ path: rel, line: j.data.line_number ?? 0, text: (j.data.lines?.text ?? '').trimEnd().slice(0, 1500) })
      }
    } else {
      let re: RegExp
      try {
        const src = a.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        re = new RegExp(src, a.caseSensitive ? '' : 'i')
      } catch (err) {
        throw new Error(`正则写法有误：${(err as Error).message}`)
      }
      const stopped = await this.walkFiles(root, async (rel, full) => {
        if (glob && !matchGlob(glob, rel)) return true
        let buf: Buffer
        try {
          const st = await fsp.stat(full)
          if (st.size > 1024 * 1024) return true
          buf = await fsp.readFile(full)
        } catch {
          return true
        }
        if (buf.subarray(0, 8192).includes(0)) return true
        const lines = buf.toString('utf8').split(/\r?\n/)
        let perFile = 0
        for (let i = 0; i < lines.length && perFile < 20; i++) {
          if (re.test(lines[i])) {
            matches.push({ path: rel, line: i + 1, text: lines[i].trimEnd().slice(0, 1500) })
            perFile++
          }
        }
        return matches.length <= limit
      })
      truncated = stopped
    }
    return {
      matches: matches.slice(0, limit),
      truncated: truncated || matches.length > limit,
      note: '每个文件最多 20 个匹配行；过长的行会被截短。',
      engine: this.deps.rgPath ? 'ripgrep' : 'scan',
    }
  }

  async readFiles(root: string, files: unknown): Promise<{ files: Array<Record<string, unknown>> }> {
    if (!Array.isArray(files) || files.length < 1 || files.length > 10) throw new Error('每次读取 1 至 10 个文件')
    let remaining = READ_BUDGET
    const out: Array<Record<string, unknown>> = []
    for (const item of files as Array<{ path?: unknown; startLine?: unknown; endLine?: unknown }>) {
      const shown = typeof item?.path === 'string' ? item.path : String(item?.path)
      try {
        const p = await this.resolveInside(root, item?.path)
        const stat = await fsp.stat(p)
        if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('只支持不超过 1 MB 的文本文件')
        const buffer = await fsp.readFile(p)
        if (buffer.includes(0)) throw new Error('不支持二进制文件')
        const lines = buffer.toString('utf8').split(/\r?\n/)
        const start = bounded(item.startLine, 1, 10_000_000)
        const end = bounded(item.endLine, start + 299, 10_000_000)
        if (end < start) throw new Error('endLine 必须不小于 startLine')
        const stop = Math.min(end, start + 999, lines.length)
        let content = lines
          .slice(start - 1, stop)
          .map((s, i) => `${start + i}: ${s}`)
          .join('\n')
        const truncated = content.length > remaining || end > stop || (item.endLine === undefined && stop < lines.length)
        content = content.slice(0, Math.max(0, remaining))
        remaining -= content.length
        out.push({ path: shown, modifiedAt: stat.mtime.toISOString(), totalLines: lines.length, content, truncated })
      } catch (err) {
        out.push({ path: shown, error: (err as Error).message })
      }
    }
    return { files: out }
  }

  async gitInspect(root: string, a: { view?: unknown; file?: unknown; limit?: unknown }): Promise<Record<string, unknown>> {
    const views: Record<string, string[]> = {
      status: ['status', '--short', '--branch'],
      diff: ['diff', '--no-ext-diff', '--no-textconv', '--no-color'],
      staged: ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-color'],
      log: ['log', `-${bounded(a.limit, 10, 30)}`, '--format=%h %ad %s', '--date=short'],
    }
    const view = typeof a.view === 'string' ? a.view : ''
    if (!Object.prototype.hasOwnProperty.call(views, view)) throw new Error('未知 Git 视图（只支持 status、diff、staged、log）')
    const args = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', ...views[view]]
    if (a.file !== undefined && a.file !== '') {
      const p = await this.resolveInside(root, a.file)
      args.push('--', toPosix(path.relative(root, p)) || '.')
    } else {
      args.push('--', '.')
    }
    const r = await runCommand(this.deps.gitPath?.() || 'git', args, root, [0], this.timeout())
    return { view, output: r.out.slice(0, 40_000), truncated: r.out.length > 40_000 || r.truncated }
  }

  async overview(): Promise<Record<string, unknown>> {
    const roots = await this.realRoots()
    if (roots.length === 0) {
      return {
        workspace: this.deps.workspaceName(),
        roots: [],
        tips: ['这个 VS Code 窗口没有打开项目文件夹。请在 VS Code 里打开一个文件夹后再试。'],
      }
    }
    return {
      workspace: this.deps.workspaceName() ?? roots[0].name,
      workspacePath: roots[0].path,
      roots: await Promise.all(
        roots.map(async (root) => {
          let git: string
          try {
            git = (await runCommand(this.deps.gitPath?.() || 'git', ['--no-optional-locks', 'status', '--short', '--branch'], root.path, [0], this.timeout())).out
          } catch {
            git = '非 Git 仓库或 Git 不可用'
          }
          return { ...root, workspacePath: root.path, ...(await this.tree(root.path, '.', 1, 80)), git: git.slice(0, 8000) }
        }),
      ),
      search: this.deps.rgPath ? 'ripgrep（VS Code 自带）' : '逐文件扫描（没找到 VS Code 自带的 ripgrep）',
      tips: [
        '后续增强工具必须传入这里返回的 workspacePath（多根工作区用对应根目录的 workspacePath）。',
        'read_files 读的是磁盘上的内容；未保存的编辑请用 read_file。',
        '修改代码前可用 show_diff 给用户看差异；运行测试可用 run_terminal_command。',
        '所有聊天共享「AI 现在操作的项目」这一个选择；切换项目后旧路径会被拒绝。',
      ],
    }
  }

  async dispatch(name: string, args: unknown): Promise<unknown> {
    const a = (args ?? {}) as Record<string, unknown>
    if (typeof a !== 'object' || Array.isArray(a)) throw new Error('参数必须是对象')
    if (name === 'workspace_overview') return this.overview()
    const roots = await this.realRoots()
    const root = await this.rootFor(a.workspacePath, roots)
    let result: Record<string, unknown>
    switch (name) {
      case 'list_directory':
        result = await this.tree(root, a.directory ?? '.', bounded(a.depth, 2, 4), bounded(a.limit, 200, 500))
        break
      case 'find_files':
        result = await this.findFiles(root, a.glob, bounded(a.limit, 200, 500))
        break
      case 'search_text':
        result = await this.searchText(root, a, bounded(a.limit, 80, 200))
        break
      case 'read_files':
        result = await this.readFiles(root, a.files)
        break
      case 'git_inspect':
        result = await this.gitInspect(root, a)
        break
      default:
        throw new Error(`未知工具：${name}`)
    }
    return { workspacePath: root, ...result }
  }
}
