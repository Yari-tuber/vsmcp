// 隔离实测：下载一份独立的 VS Code 到 .vscode-test/，用单独的 user-data-dir 和 extensions-dir，
// 窗口端口 13333 起、Hub 13340（不碰 3333–3340、3350），装上打好的 vsix，开两个窗口（两个临时项目），
// 对 http://127.0.0.1:13340/mcp 实测路由、锁定、离线不改投、Hub 接手。不开任何公网隧道。
//
// 用法：node scripts/e2e/isolated.mjs run        整套跑一遍并打印过程
//       node scripts/e2e/isolated.mjs status     看共享目录里的登记
//       node scripts/e2e/isolated.mjs cleanup    关掉本脚本开的 VS Code
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..')
const T = path.join(ROOT, '.vscode-test')
const USER_DATA = path.join(T, 'user-data')
const EXT_DIR = path.join(T, 'extensions')
const PROJECTS = path.join(T, 'projects')
const PIDS = path.join(T, 'pids.json')
const HUB = 'http://127.0.0.1:13340'
const SHARED = path.join(USER_DATA, 'User', 'globalStorage', 'yari.vsmcp')
const VSIX = path.join(ROOT, `vsmcp-${JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version}.vsix`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a)

/** 去掉可能把命令转发给用户正在用的 VS Code 的环境变量 */
function cleanEnv(extra = {}) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(VSCODE_|ELECTRON_)/i.test(k)) continue
    env[k] = v
  }
  return { ...env, ...extra }
}

async function codeExe() {
  const { downloadAndUnzipVSCode } = require('@vscode/test-electron')
  return downloadAndUnzipVSCode({ cachePath: path.join(T, 'vscode'), version: 'stable' })
}

function cliJs(exe) {
  const dir = path.dirname(exe)
  const sub = fs.readdirSync(dir).find((d) => fs.existsSync(path.join(dir, d, 'resources', 'app', 'out', 'cli.js')))
  return sub ? path.join(dir, sub, 'resources', 'app', 'out', 'cli.js') : path.join(dir, 'resources', 'app', 'out', 'cli.js')
}

const isoArgs = () => [`--user-data-dir=${USER_DATA}`, `--extensions-dir=${EXT_DIR}`]

async function setup() {
  fs.mkdirSync(path.join(USER_DATA, 'User'), { recursive: true })
  fs.mkdirSync(EXT_DIR, { recursive: true })
  const settings = {
    'vsmcp.port': 13333,
    'vsmcp.hubPort': 13340,
    'vsmcp.autoStartTunnel': false,
    'security.workspace.trust.enabled': false,
    'update.mode': 'none',
    'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
    'telemetry.telemetryLevel': 'off',
    'workbench.startupEditor': 'none',
    'workbench.tips.enabled': false,
    'workbench.welcomePage.walkthroughs.openOnInstall': false,
    'window.restoreWindows': 'none',
    'chat.disableAIFeatures': true,
    'git.openRepositoryInParentFolders': 'never',
  }
  fs.writeFileSync(path.join(USER_DATA, 'User', 'settings.json'), JSON.stringify(settings, null, 2))
  for (const name of ['alpha', 'beta']) {
    const dir = path.join(PROJECTS, name)
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n\n测试项目 ${name}\n`)
    fs.writeFileSync(path.join(dir, 'src', `${name}.ts`), `export const who = '${name}'\n`)
    fs.writeFileSync(path.join(dir, '.env'), `SECRET_${name.toUpperCase()}=do-not-leak\n`)
  }
  const exe = await codeExe()
  log('VS Code：', exe)
  if (!fs.existsSync(VSIX)) throw new Error(`没找到 ${VSIX}，先 npm run package`)
  const r = spawnSync(exe, [cliJs(exe), ...isoArgs(), '--install-extension', VSIX, '--force'], {
    env: cleanEnv({ ELECTRON_RUN_AS_NODE: '1' }),
    encoding: 'utf8',
  })
  log('安装 vsix：', (r.stdout || '').trim(), (r.stderr || '').trim())
  const list = spawnSync(exe, [cliJs(exe), ...isoArgs(), '--list-extensions', '--show-versions'], { env: cleanEnv({ ELECTRON_RUN_AS_NODE: '1' }), encoding: 'utf8' })
  log('隔离 extensions-dir 里的扩展：', (list.stdout || '').trim().split(/\r?\n/).join(', '))
  return exe
}

function savePid(pid) {
  const pids = fs.existsSync(PIDS) ? JSON.parse(fs.readFileSync(PIDS, 'utf8')) : []
  pids.push(pid)
  fs.writeFileSync(PIDS, JSON.stringify(pids))
}

async function open(exe, folder, newWindow = true) {
  const child = spawn(exe, [...isoArgs(), newWindow ? '--new-window' : '--reuse-window', '--disable-workspace-trust', folder], {
    env: cleanEnv(),
    detached: true,
    stdio: 'ignore',
  })
  savePid(child.pid)
  child.unref()
  log(`启动 Code.exe（pid ${child.pid}）打开 ${path.basename(folder)}`)
  return child.pid
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

function windows() {
  const dir = path.join(SHARED, 'windows')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(dir, f)))
    .filter((w) => w && Date.now() - w.updatedAt < 10_000)
}

function status() {
  return {
    windows: windows().map((w) => ({ name: w.name, port: w.port, pid: w.pid, sessionId: w.sessionId.slice(0, 8), focusedAt: w.focusedAt })),
    hub: readJson(path.join(SHARED, 'hub.json')),
    state: readJson(path.join(SHARED, 'state.json')),
    focus: readJson(path.join(SHARED, 'focus.json')),
  }
}

async function waitFor(label, fn, timeoutMs = 60_000) {
  const start = Date.now()
  for (;;) {
    let v
    try {
      v = await fn()
    } catch {
      v = null
    }
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`)
    await sleep(500)
  }
}

let rpcId = 0
async function rpc(method, params = {}, url = `${HUB}/mcp`, timeoutMs = 30_000) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 不是 JSON */
  }
  return { status: res.status, json, text }
}

async function callTool(name, args = {}, timeoutMs = 30_000) {
  const r = await rpc('tools/call', { name, arguments: args }, `${HUB}/mcp`, timeoutMs)
  const text = r.json?.result?.content?.[0]?.text
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  return { ...r, data, isError: !!r.json?.result?.isError, error: r.json?.error }
}

async function overviewName() {
  const r = await callTool('workspace_overview')
  if (r.status !== 200) return `HTTP ${r.status}：${r.json?.error?.message ?? r.text.slice(0, 200)}`
  return r.data?.workspace
}

async function health() {
  const res = await fetch(`${HUB}/health`, { signal: AbortSignal.timeout(5000) })
  return { status: res.status, ...(await res.json()) }
}

const results = []
function check(label, ok, detail) {
  results.push({ label, ok: !!ok, detail })
  log(`${ok ? '✔' : '✖'} ${label}${detail !== undefined ? ` —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

async function run() {
  if (fs.existsSync(PIDS)) fs.rmSync(PIDS)
  // 共享目录每次从干净的开始
  fs.rmSync(SHARED, { recursive: true, force: true })
  fs.rmSync(path.join(USER_DATA, 'logs'), { recursive: true, force: true })
  const exe = await setup()
  const alpha = path.join(PROJECTS, 'alpha')
  const beta = path.join(PROJECTS, 'beta')

  await open(exe, alpha)
  await waitFor('alpha 窗口登记', () => windows().some((w) => w.name === 'alpha'), 120_000)
  await waitFor('Hub 上线', async () => (await health()).service === 'vsmcp-hub', 30_000)
  await open(exe, beta)
  await waitFor('beta 窗口登记', () => windows().some((w) => w.name === 'beta'), 90_000)
  const ws = windows()
  log('两个窗口：', JSON.stringify(status().windows))
  check('两个窗口各有自己的端口，都在 13333 起的范围里', ws.length === 2 && ws.every((w) => w.port >= 13333 && w.port <= 13337) && ws[0].port !== ws[1].port, ws.map((w) => `${w.name}:${w.port}`).join(' '))
  check('两个窗口的 sessionId 不同', new Set(ws.map((w) => w.sessionId)).size === 2)
  const hubRec = status().hub
  check('只有一个窗口当 Hub（13340）', hubRec && hubRec.port === 13340, `Hub = ${hubRec?.name}`)

  // 1. initialize / tools/list / workspace_overview
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })
  check('initialize（经 Hub）', init.status === 200 && init.json?.result?.serverInfo?.name === 'vsmcp', `HTTP ${init.status} serverInfo=${JSON.stringify(init.json?.result?.serverInfo)} protocol=${init.json?.result?.protocolVersion}`)
  const list = await rpc('tools/list')
  const tools = list.json?.result?.tools ?? []
  check('tools/list 有 33 个工具', tools.length === 33, `${tools.length} 个`)
  const destructive = tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name).sort()
  check('destructiveHint 只标在 5 个工具上', destructive.join(',') === 'delete_file,execute_vscode_command,kill_terminal,run_terminal_command,write_terminal', destructive.join(','))
  const ro = tools.filter((t) => t.annotations?.readOnlyHint).length
  check('只读工具带 readOnlyHint', ro >= 20, `${ro} 个只读`)
  const ov = await callTool('workspace_overview')
  check('workspace_overview（自动跟随，最后打开的是 beta）', ov.data?.workspace === 'beta', `${ov.data?.workspace} @ ${ov.data?.workspacePath} · 搜索：${ov.data?.search}`)

  // 增强工具在真 VS Code 里：VS Code 自带 rg、凭据过滤
  const search = await callTool('search_text', { workspacePath: ov.data?.workspacePath, query: 'do-not-leak' })
  check('search_text 搜不到 .env 里的内容', search.data?.matches?.length === 0, `engine=${search.data?.engine} matches=${search.data?.matches?.length}`)
  const read = await callTool('read_files', { workspacePath: ov.data?.workspacePath, files: [{ path: '.env' }, { path: 'src/beta.ts' }] })
  check('read_files 读 .env 被拒、读正常文件可以', /凭据/.test(read.data?.files?.[0]?.error ?? '') && /who = 'beta'/.test(read.data?.files?.[1]?.content ?? ''), read.data?.files?.map((f) => f.error ?? f.content).join(' | '))

  // 上游工具在真 VS Code 里
  const info = await callTool('get_workspace_info')
  check('get_workspace_info（上游工具）', info.data?.folders?.[0]?.path?.toLowerCase() === ov.data?.workspacePath?.toLowerCase(), JSON.stringify(info.data))
  const rf = await callTool('read_file', { filePath: path.join(ov.data?.workspacePath ?? '', 'src', 'beta.ts') })
  check('read_file（上游工具，走 VS Code 文档 API）', /who = 'beta'/.test(rf.data?.content ?? ''), JSON.stringify(rf.data))
  const diff = await callTool('show_diff', { filePath: path.join(ov.data?.workspacePath ?? '', 'src', 'beta.ts'), newContent: "export const who = 'beta (改)'\n" })
  check('show_diff（上游工具，内存文件系统 vsmcp-preview: 打开差异编辑器）', diff.data?.shown === true, JSON.stringify(diff.data ?? diff.text))
  const echo = await callTool('run_terminal_command', { command: 'echo vsmcp-ok' })
  check('run_terminal_command（上游工具）', /vsmcp-ok/.test(echo.data?.stdout ?? ''), JSON.stringify(echo.data))
  const t1 = Date.now()
  const longCmd = await callTool('run_terminal_command', { command: 'C:\\Windows\\System32\\PING.EXE -n 41 127.0.0.1', timeoutMs: 120_000 }, 150_000)
  const secs = (Date.now() - t1) / 1000
  check('长命令（约 40 秒）经 Hub 不被 35 秒掐断', longCmd.status === 200 && longCmd.data?.exitCode === 0 && secs > 38, `${secs.toFixed(1)} 秒，HTTP ${longCmd.status}，exitCode=${longCmd.data?.exitCode}`)

  // 侧栏面板：在目标窗口里打开控制台，面板脚本跑起来会回一条 ready，扩展把它写进输出日志
  await callTool('execute_vscode_command', { command: 'vsmcp.openPanel' })
  const panelOk = await waitFor('面板加载', () => grepLogs('侧栏面板已加载'), 20_000).catch(() => null)
  check('侧栏面板在真 VS Code 里加载（webview 脚本通过 CSP、回了 ready）', !!panelOk, panelOk ?? '日志里没找到')

  // 2. 自动跟随：再打开 alpha（已开着的窗口会被拉到前台，触发窗口焦点事件）
  await open(exe, alpha, false)
  const followedAlpha = await waitFor('自动跟随到 alpha', async () => ((await overviewName()) === 'alpha' ? 'alpha' : null), 20_000).catch(() => null)
  check('自动跟随：把 alpha 窗口带到前台后，返回 alpha', followedAlpha === 'alpha', followedAlpha ?? `仍是 ${await overviewName()}（Windows 可能拦住了后台进程抢前台焦点）`)
  await open(exe, beta, false)
  const followedBeta = await waitFor('自动跟随到 beta', async () => ((await overviewName()) === 'beta' ? 'beta' : null), 20_000).catch(() => null)
  check('自动跟随：再切到 beta，返回 beta', followedBeta === 'beta', followedBeta ?? `仍是 ${await overviewName()}`)

  // 3. 锁定：经 execute_vscode_command 在目标窗口里执行插件自己的命令（和点面板按钮走同一段代码）
  const cur = await overviewName()
  const lock = await callTool('execute_vscode_command', { command: 'vsmcp.lockCurrent' })
  check(`锁定当前项目（${cur}）`, lock.status === 200 && !lock.isError && status().state?.mode === 'manual', JSON.stringify(status().state))
  const other = cur === 'alpha' ? beta : alpha
  const otherName = cur === 'alpha' ? 'beta' : 'alpha'
  await open(exe, other, false)
  await sleep(3000)
  check(`锁定后切到 ${otherName} 窗口，目标不变`, (await overviewName()) === cur, await overviewName())
  const otherKey = windows().find((w) => w.name === otherName)?.key
  await callTool('execute_vscode_command', { command: 'vsmcp.lock', args: [otherKey] })
  check(`锁定切换到 ${otherName}（vsmcp.lock + key，面板点项目同一段代码）`, (await overviewName()) === otherName, await overviewName())
  const h1 = await health()
  check('/health 显示当前目标和模式', h1.workspace === otherName && h1.mode === 'manual', JSON.stringify(h1))

  // 4. 回到自动跟随
  await callTool('execute_vscode_command', { command: 'vsmcp.autoFollow' })
  check('自动跟随（在目标窗口里执行 vsmcp.autoFollow，本窗口即最后点过的）', status().state?.mode === 'auto' && (await overviewName()) === otherName, `${status().state?.mode} → ${await overviewName()}`)

  // 5. SSE 传输经 Hub
  const sse = await sseRoundTrip()
  check('SSE 经 Hub：endpoint 事件 + /messages + tools/list 结果从 SSE 流回来', sse.ok, sse.detail)

  // 6. Hub 接手 + 目标离线不改投：锁定 Hub 所在窗口，再把它关掉
  const hubBefore = status().hub
  const hubWin = windows().find((w) => w.sessionId === hubBefore.sessionId)
  const survivor = windows().find((w) => w.sessionId !== hubBefore.sessionId)
  log(`Hub 现在是「${hubWin?.name}」窗口（pid ${hubBefore.pid}），准备锁定它再关掉`)
  await callTool('execute_vscode_command', { command: 'vsmcp.lock', args: [hubWin.key] })
  check(`锁定 Hub 窗口的项目（${hubWin.name}）`, (await overviewName()) === hubWin.name)
  const closeReq = callTool('execute_vscode_command', { command: 'workbench.action.closeWindow' }).catch((e) => ({ status: 0, text: String(e) }))
  const t0 = Date.now()
  await waitFor('Hub 窗口注销', () => !windows().some((w) => w.sessionId === hubWin.sessionId), 30_000)
  const newHub = await waitFor('新 Hub 接手', () => {
    const h = status().hub
    return h && h.sessionId !== hubBefore.sessionId && Date.now() - h.updatedAt < 5000 ? h : null
  }, 30_000)
  const takeoverMs = Date.now() - t0
  await closeReq
  check('关掉 Hub 窗口后另一个窗口接手 Hub', newHub.sessionId === survivor.sessionId && newHub.port === 13340, `新 Hub = ${newHub.name}，${(takeoverMs / 1000).toFixed(1)} 秒内（含窗口关闭时间）`)
  const off = await rpc('tools/call', { name: 'workspace_overview', arguments: {} })
  check(`锁定的 ${hubWin.name} 已关：返回错误，不改投 ${survivor.name}`, off.status === 503 && /不会改投/.test(off.json?.error?.message ?? ''), `HTTP ${off.status}：${off.json?.error?.message}`)
  const h2 = await health()
  check('新 Hub 的 /health', h2.service === 'vsmcp-hub' && h2.status === 'no_workspace', JSON.stringify(h2))

  // 7. 重新打开刚才关掉的项目：目标恢复；再把锁定换到幸存窗口
  await open(exe, path.join(PROJECTS, hubWin.name))
  await waitFor('重新打开的窗口登记', () => windows().some((w) => w.name === hubWin.name), 90_000)
  check(`重新打开 ${hubWin.name} 后锁定目标恢复`, (await waitFor('目标恢复', async () => ((await overviewName()) === hubWin.name ? hubWin.name : null), 20_000).catch(() => null)) === hubWin.name)
  check('Hub 没有换回去（还是接手的那个窗口）', status().hub?.sessionId === survivor.sessionId, status().hub?.name)

  // 8. 多开同一个项目：用一个只含同一文件夹的 .code-workspace 再开一个窗口（工作区 key 相同）
  const wsFile = path.join(PROJECTS, `${hubWin.name}-again.code-workspace`)
  fs.writeFileSync(wsFile, JSON.stringify({ folders: [{ path: hubWin.name }] }))
  await open(exe, wsFile)
  const dup = await waitFor('同项目第二个窗口登记', () => windows().filter((w) => w.key === hubWin.key).length === 2, 60_000).catch(() => false)
  if (dup) {
    const d = await rpc('tools/call', { name: 'workspace_overview', arguments: {} })
    check('同一项目开了两个窗口：拒绝猜', d.status === 503 && /2 个窗口/.test(d.json?.error?.message ?? ''), `HTTP ${d.status}：${d.json?.error?.message}`)
  } else {
    check('同一项目开了两个窗口：拒绝猜', false, 'VS Code 没有给同一文件夹开第二个窗口（--new-window 打开已开着的文件夹会直接聚焦已有窗口）')
  }

  console.log('\n结果：' + results.filter((r) => r.ok).length + ' / ' + results.length + ' 通过')
  fs.writeFileSync(path.join(T, 'e2e-result.json'), JSON.stringify({ at: new Date().toISOString(), results, status: status() }, null, 2))
}

/** 在隔离 user-data 的日志目录里找 VSMCP 输出频道写下的某句话 */
function grepLogs(needle) {
  const base = path.join(USER_DATA, 'logs')
  const stack = [base]
  while (stack.length) {
    const dir = stack.pop()
    let list = []
    try {
      list = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of list) {
      const p = path.join(dir, d.name)
      if (d.isDirectory()) stack.push(p)
      else if (/VSMCP\.log$/.test(d.name)) {
        const line = fs.readFileSync(p, 'utf8').split(/\r?\n/).find((l) => l.includes(needle))
        if (line) return line.trim()
      }
    }
  }
  return null
}

async function sseRoundTrip() {
  const ctrl = new AbortController()
  try {
    const res = await fetch(`${HUB}/sse`, { signal: ctrl.signal, headers: { Accept: 'text/event-stream' } })
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    const readUntil = async (re, ms) => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        const m = buf.match(re)
        if (m) return m
        const { value, done } = await Promise.race([reader.read(), sleep(end - Date.now()).then(() => ({ value: null, done: false }))])
        if (done) break
        if (value) buf += dec.decode(value, { stream: true })
      }
      return buf.match(re)
    }
    const ep = await readUntil(/data: (\/messages\?sessionId=[\w-]+)/, 10_000)
    if (!ep) return { ok: false, detail: `没收到 endpoint 事件：${buf.slice(0, 200)}` }
    const post = (body) => fetch(`${HUB}${ep[1]}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sse-e2e', version: '1' } } })
    await readUntil(/"id":1/, 10_000)
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const r = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    const m = await readUntil(/data: (\{.*"tools":\[.*\})\r?\n/, 10_000)
    const count = m ? JSON.parse(m[1]).result.tools.length : 0
    return { ok: r.status === 202 && count === 33, detail: `POST /messages → ${r.status}，SSE 流回 tools/list ${count} 个工具` }
  } catch (err) {
    return { ok: false, detail: String(err) }
  } finally {
    ctrl.abort()
  }
}

async function cleanup() {
  // 先正常退出：直接对某个窗口自己的端口发 quit（Hub 那边可能因为多开 / 离线没有目标）
  for (const w of windows()) {
    try {
      await rpc('tools/call', { name: 'execute_vscode_command', arguments: { command: 'workbench.action.quit' } }, `http://127.0.0.1:${w.port}/mcp`, 5000)
      log(`已让隔离 VS Code 正常退出（经 ${w.name} 窗口 :${w.port}）`)
      break
    } catch {
      /* 退出时连接会被掐断，换下一个窗口试 */
      break
    }
  }
  await sleep(5000)
  // 只结束可执行文件在 .vscode-test 里的进程（都是本脚本下载、启动的那份 VS Code），
  // 不按记下的 PID 杀，免得 PID 被系统复用后误伤别的进程
  const dir = path.join(T, 'vscode').replace(/'/g, "''")
  const ps =
    "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('" +
    dir +
    "', [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.ProcessId }"
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' })
  const left = (r.stdout || '').split(/\s+/).filter(Boolean)
  if (left.length) {
    log(`还剩 ${left.length} 个隔离 VS Code 进程，结束它们：${left.join(', ')}`)
    for (const pid of left) spawnSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' })
  } else {
    log('隔离 VS Code 已经全部退出')
  }
  log('清理后共享目录：', JSON.stringify(status()))
}

const cmd = process.argv[2] ?? 'run'
if (cmd === 'run') {
  run()
    .catch((err) => {
      log('出错：', err.message)
      process.exitCode = 1
    })
    .finally(() => {
      if (!process.argv.includes('--keep')) return cleanup()
    })
} else if (cmd === 'status') {
  console.log(JSON.stringify(status(), null, 2))
} else if (cmd === 'cleanup') {
  cleanup()
} else if (cmd === 'setup') {
  setup()
}
