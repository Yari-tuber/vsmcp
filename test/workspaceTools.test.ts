import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { WorkspaceTools, globToRegExp, matchGlob, isSecretPath } from '../src/tools/workspaceTools.js'
import { findBundledRipgrep } from '../src/tools/ripgrep.js'
import { tmpDir, rmrf } from './helpers.js'

/** 找一个 rg 来测 ripgrep 那条路：VSMCP_TEST_RG > 工作目录 .vscode-test 里下载的 VS Code 自带的 */
function locateRg(): string | null {
  if (process.env.VSMCP_TEST_RG && fs.existsSync(process.env.VSMCP_TEST_RG)) return process.env.VSMCP_TEST_RG
  const base = path.resolve(__dirname, '..', '.vscode-test')
  const stack = [base]
  let depth = 0
  while (stack.length && depth < 400) {
    const dir = stack.shift()!
    depth++
    let list: fs.Dirent[] = []
    try {
      list = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of list) {
      if (!d.isDirectory()) continue
      const p = path.join(dir, d.name)
      if (d.name === 'app' && path.basename(dir) === 'resources') {
        const rg = findBundledRipgrep(p)
        if (rg) return rg
      } else if (!['extensions', 'node_modules', 'user-data', 'projects', 'ud', 'ext'].includes(d.name)) {
        stack.push(p)
      }
    }
  }
  return null
}

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

let root = ''
let outside = ''

function setupFixture(): void {
  root = fs.realpathSync(tmpDir('ws'))
  outside = fs.realpathSync(tmpDir('outside'))
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true })
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'example.txt'), 'hello 世界\nNeedle here\nthird line\n')
  fs.writeFileSync(path.join(root, 'src', 'deep', 'mod.ts'), 'export const needle = 1\n')
  fs.writeFileSync(path.join(root, 'README.md'), '# demo\n')
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=Needle-in-env\n')
  fs.writeFileSync(path.join(root, 'src', 'server.pem'), 'Needle pem\n')
  fs.writeFileSync(path.join(root, 'id_rsa'), 'Needle key\n')
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'ignored.txt'), 'Needle in deps\n')
  fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside Needle\n')
  // 大文件：2500 行 × 60 字，用来测截断
  fs.writeFileSync(path.join(root, 'big.txt'), Array.from({ length: 2500 }, (_, i) => `line ${i + 1} ` + 'x'.repeat(50)).join('\n'))
  // 指到工作区外面的符号链接 / 目录联接
  fs.symlinkSync(outside, path.join(root, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir')
}

const rg = locateRg()
const engines: Array<[string, string | null]> = [['逐文件扫描', null]]
if (rg) engines.push(['ripgrep', rg])

describe('增强工具', () => {
  before(setupFixture)
  after(() => {
    rmrf(root)
    rmrf(outside)
  })

  const make = (rgPath: string | null) =>
    new WorkspaceTools({ getRoots: () => [{ name: 'fixture', path: root }], workspaceName: () => 'fixture', rgPath })

  test(`有 rg 可测：${rg ?? '（没找到，只测逐文件扫描）'}`, () => {
    assert.ok(true)
  })

  for (const [label, rgPath] of engines) {
    describe(label, () => {
      test('workspace_overview：根路径、顶层目录，不列依赖和凭据', async () => {
        const t = make(rgPath)
        const o = (await t.dispatch('workspace_overview', {})) as any
        assert.equal(o.workspace, 'fixture')
        assert.equal(o.workspacePath, root)
        const names = o.roots[0].entries.map((e: any) => e.path)
        assert.ok(names.includes('src'))
        assert.ok(names.includes('README.md'))
        assert.ok(!names.includes('node_modules'))
        assert.ok(!names.includes('.env'))
        assert.ok(!names.includes('id_rsa'))
      })

      test('workspacePath 校验：没传 / 传了别的项目都拒绝', async () => {
        const t = make(rgPath)
        await assert.rejects(t.dispatch('list_directory', {}), /workspace_overview/)
        await assert.rejects(t.dispatch('list_directory', { workspacePath: outside }), /工作区已切换/)
        await assert.rejects(t.dispatch('find_files', { workspacePath: path.join(root, 'nope'), glob: '*' }), /工作区已切换/)
        // 大小写不同但是同一个目录（Windows）也认
        if (process.platform === 'win32') {
          const r = (await t.dispatch('list_directory', { workspacePath: root.toUpperCase(), depth: 1 })) as any
          assert.equal(r.workspacePath, root)
        }
      })

      test('list_directory：跳过依赖、隐藏、凭据，符号链接标成 link 不展开', async () => {
        const t = make(rgPath)
        const r = (await t.dispatch('list_directory', { workspacePath: root, depth: 3 })) as any
        const paths = r.entries.map((e: any) => e.path)
        assert.ok(paths.includes('src/example.txt'))
        assert.ok(paths.includes('src/deep/mod.ts'))
        assert.ok(!paths.some((p: string) => p.includes('node_modules') || p === '.env' || p.endsWith('.pem') || p === 'id_rsa'))
        assert.equal(r.entries.find((e: any) => e.path === 'outside-link')?.type, 'link')
        assert.ok(!paths.includes('outside-link/outside.txt'))
        const limited = (await t.dispatch('list_directory', { workspacePath: root, depth: 3, limit: 2 })) as any
        assert.equal(limited.entries.length, 2)
        assert.equal(limited.truncated, true)
      })

      test('路径越界：../、绝对路径、符号链接 / 目录联接跳出去都拒绝', async () => {
        const t = make(rgPath)
        await assert.rejects(t.dispatch('list_directory', { workspacePath: root, directory: 'outside-link' }), /超出/)
        await assert.rejects(t.dispatch('list_directory', { workspacePath: root, directory: '..' }), /超出/)
        const r = (await t.dispatch('read_files', {
          workspacePath: root,
          files: [{ path: '../' + path.basename(outside) + '/outside.txt' }, { path: path.join(outside, 'outside.txt') }, { path: 'outside-link/outside.txt' }],
        })) as any
        assert.equal(r.files.length, 3)
        for (const f of r.files) assert.match(f.error, /超出/)
        await assert.rejects(t.dispatch('git_inspect', { workspacePath: root, view: 'status', file: 'outside-link/outside.txt' }), /超出/)
      })

      test('凭据文件过滤：读不到、搜不到、找不到', async () => {
        const t = make(rgPath)
        const r = (await t.dispatch('read_files', { workspacePath: root, files: [{ path: '.env' }, { path: 'id_rsa' }, { path: 'src/server.pem' }] })) as any
        for (const f of r.files) assert.match(f.error, /凭据/)
        const s = (await t.dispatch('search_text', { workspacePath: root, query: 'needle' })) as any
        const hits = s.matches.map((m: any) => m.path).sort()
        assert.deepEqual(hits, ['src/deep/mod.ts', 'src/example.txt'])
        assert.equal(s.matches.find((m: any) => m.path === 'src/example.txt').line, 2)
        const f = (await t.dispatch('find_files', { workspacePath: root, glob: '*' })) as any
        assert.ok(!f.files.some((p: string) => p.endsWith('.env') || p.endsWith('.pem') || p.endsWith('id_rsa')))
      })

      test('find_files：glob 匹配，跳过依赖，超出 limit 标截断', async () => {
        const t = make(rgPath)
        const r = (await t.dispatch('find_files', { workspacePath: root, glob: '**/*.txt' })) as any
        assert.deepEqual(r.files.sort(), ['big.txt', 'src/example.txt'])
        assert.equal(r.engine, rgPath ? 'ripgrep' : 'scan')
        const ts = (await t.dispatch('find_files', { workspacePath: root, glob: '*.ts' })) as any
        assert.deepEqual(ts.files, ['src/deep/mod.ts'])
        const one = (await t.dispatch('find_files', { workspacePath: root, glob: '**/*', limit: 1 })) as any
        assert.equal(one.files.length, 1)
        assert.equal(one.truncated, true)
        await assert.rejects(t.dispatch('find_files', { workspacePath: root, glob: '' }), /glob/)
      })

      test('search_text：大小写、正则、glob、limit 截断', async () => {
        const t = make(rgPath)
        const cs = (await t.dispatch('search_text', { workspacePath: root, query: 'needle', caseSensitive: true })) as any
        assert.deepEqual(cs.matches.map((m: any) => m.path), ['src/deep/mod.ts'])
        const re = (await t.dispatch('search_text', { workspacePath: root, query: 'line \\d+5 ', regex: true, glob: '*.txt' })) as any
        assert.ok(re.matches.length > 10)
        const lim = (await t.dispatch('search_text', { workspacePath: root, query: 'line', limit: 3 })) as any
        assert.equal(lim.matches.length, 3)
        assert.equal(lim.truncated, true)
        await assert.rejects(t.dispatch('search_text', { workspacePath: root, query: 'a\nb' }), /单行/)
      })

      test('read_files：行范围、行号、单文件 1000 行上限、总量 8 万字截断', async () => {
        const t = make(rgPath)
        const one = (await t.dispatch('read_files', { workspacePath: root, files: [{ path: 'src/example.txt', startLine: 2, endLine: 2 }] })) as any
        assert.equal(one.files[0].content, '2: Needle here')
        assert.equal(one.files[0].truncated, false)
        const def = (await t.dispatch('read_files', { workspacePath: root, files: [{ path: 'big.txt' }] })) as any
        assert.equal(def.files[0].content.split('\n').length, 300, '不给 endLine 默认读 300 行')
        assert.equal(def.files[0].truncated, true)
        assert.equal(def.files[0].totalLines, 2500)
        const wide = (await t.dispatch('read_files', { workspacePath: root, files: [{ path: 'big.txt', startLine: 1, endLine: 2500 }] })) as any
        assert.equal(wide.files[0].content.split('\n').length, 1000, '单个文件一次最多 1000 行')
        assert.equal(wide.files[0].truncated, true)
        const many = (await t.dispatch('read_files', {
          workspacePath: root,
          files: [
            { path: 'big.txt', startLine: 1, endLine: 1000 },
            { path: 'big.txt', startLine: 1001, endLine: 2000 },
            { path: 'big.txt', startLine: 2001, endLine: 2500 },
          ],
        })) as any
        const total = many.files.reduce((n: number, f: any) => n + (f.content?.length ?? 0), 0)
        assert.ok(total <= 80_000, `总量不超过 8 万字（实际 ${total}）`)
        assert.equal(many.files[1].truncated, true)
        assert.equal(many.files[2].content, '')
        await assert.rejects(t.dispatch('read_files', { workspacePath: root, files: [] }), /1 至 10/)
        const missing = (await t.dispatch('read_files', { workspacePath: root, files: [{ path: 'nope.txt' }] })) as any
        assert.match(missing.files[0].error, /不存在/)
      })
    })
  }

  test('git_inspect：status / staged / diff / log，未知视图拒绝', { skip: !hasGit() && '没有 git' }, async () => {
    const t = make(rg)
    execFileSync('git', ['init', '--quiet'], { cwd: root })
    const st = (await t.dispatch('git_inspect', { workspacePath: root, view: 'status' })) as any
    assert.match(st.output, /src\//)
    execFileSync('git', ['add', 'src/example.txt'], { cwd: root })
    assert.match(((await t.dispatch('git_inspect', { workspacePath: root, view: 'staged' })) as any).output, /Needle/)
    execFileSync('git', ['-c', 'user.name=VSMCP Test', '-c', 'user.email=vsmcp-test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--no-verify', '-m', 'fixture'], { cwd: root })
    fs.appendFileSync(path.join(root, 'src', 'example.txt'), 'changed\n')
    assert.match(((await t.dispatch('git_inspect', { workspacePath: root, view: 'diff', file: 'src/example.txt' })) as any).output, /\+changed/)
    assert.match(((await t.dispatch('git_inspect', { workspacePath: root, view: 'log' })) as any).output, /fixture/)
    await assert.rejects(t.dispatch('git_inspect', { workspacePath: root, view: 'push' }), /未知 Git 视图/)
  })
})

test('glob 兜底匹配和 rg 一致：不带 / 的匹配文件名', () => {
  assert.ok(matchGlob('*.ts', 'src/deep/mod.ts'))
  assert.ok(matchGlob('**/*.ts', 'mod.ts'))
  assert.ok(matchGlob('**/*.ts', 'a/b/mod.ts'))
  assert.ok(matchGlob('src/**/*.{ts,js}', 'src/a/b.js'))
  assert.ok(!matchGlob('src/*.ts', 'src/a/b.ts'))
  assert.ok(matchGlob('**/package.json', 'package.json'))
  assert.ok(matchGlob('file?.md', 'file1.md'))
  assert.ok(globToRegExp('[ab].txt', false).test('a.txt'))
  assert.ok(!globToRegExp('[!ab].txt', false).test('a.txt'))
})

test('凭据文件规则', () => {
  for (const p of ['.env', '.env.local', 'config/.env.production', 'id_rsa', 'id_ed25519', 'credentials', 'credentials.json', 'secrets.yaml', 'secret', 'a/b/server.key', 'cert.pem', 'x.p12', 'y.pfx']) {
    assert.ok(isSecretPath(p), p)
  }
  for (const p of ['src/env.ts', 'environment.md', 'keys.ts', 'secretary.txt', 'README.md', 'id_rsa.pub.txt']) {
    assert.ok(!isSecretPath(p), p)
  }
})

test('找 VS Code 自带的 ripgrep：旧布局、新布局（ripgrep-universal）、都没有', () => {
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg'
  const a = tmpDir('approot-old')
  const b = tmpDir('approot-new')
  const c = tmpDir('approot-none')
  try {
    const oldRg = path.join(a, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', exe)
    fs.mkdirSync(path.dirname(oldRg), { recursive: true })
    fs.writeFileSync(oldRg, '')
    assert.equal(findBundledRipgrep(a), oldRg)
    const newRg = path.join(b, 'node_modules.asar.unpacked', '@vscode', 'ripgrep-universal', 'bin', `${process.platform}-${process.arch}`, exe)
    fs.mkdirSync(path.dirname(newRg), { recursive: true })
    fs.writeFileSync(newRg, '')
    assert.equal(findBundledRipgrep(b), newRg)
    assert.equal(findBundledRipgrep(c), null)
    assert.equal(findBundledRipgrep(undefined), null)
  } finally {
    rmrf(a)
    rmrf(b)
    rmrf(c)
  }
})
