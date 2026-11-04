import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'http'
import { HubElection, HubServer } from '../src/hub/HubServer.js'
import { HubRuntime } from '../src/hub/HubRuntime.js'
import { SharedDir, type WindowRecord } from '../src/hub/registry.js'
import { selectTarget } from '../src/hub/route.js'
import type { ManagedTunnel } from '../src/tunnel/TunnelSupervisor.js'
import { win, tmpDir, rmrf, freePort, listen, close, postJson, sleep, waitFor } from './helpers.js'

/** 假窗口：/mcp 回自己的名字（可以故意慢），/sse 发 endpoint 事件，/messages 记录收到的会话 */
function fakeWindow(name: string, opts: { delayMs?: number } = {}) {
  const got: string[] = []
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/sse') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`event: endpoint\ndata: /messages?sessionId=sess-${name}\n\n`)
      return
    }
    if (url.pathname === '/messages') {
      got.push(url.searchParams.get('sessionId') ?? '')
      res.writeHead(202)
      res.end(name)
      return
    }
    let body = ''
    for await (const c of req) body += c
    if (opts.delayMs) await sleep(opts.delayMs)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { window: name, echo: body ? JSON.parse(body) : null } }))
  })
  return { server, got }
}

function fixedRoute(shared: SharedDir) {
  return () => selectTarget(shared.listWindows(), shared.readState(), shared.readFocus(), Date.now())
}

test('Hub 转发：自动跟随、锁定切换、目标离线不改投、多开拒绝', async () => {
  const dir = tmpDir('hub')
  const A = fakeWindow('alpha')
  const B = fakeWindow('beta')
  const pa = await listen(A.server)
  const pb = await listen(B.server)
  const shared = new SharedDir(dir)
  shared.ensure()
  const hub = new HubServer({ resolveRoute: fixedRoute(shared), version: 'test' })
  const hubPort = await freePort()
  try {
    assert.equal(await hub.listen(hubPort), true)
    const wa = win('alpha', pa, { sessionId: 'sa' })
    const wb = win('beta', pb, { sessionId: 'sb' })
    shared.writeWindow(wa)
    shared.writeWindow(wb)
    const call = () => postJson(`http://127.0.0.1:${hubPort}/mcp`, { jsonrpc: '2.0', id: 1, method: 'ping' })

    // 自动跟随
    shared.writeFocus({ key: wa.key, name: 'alpha', sessionId: 'sa', at: Date.now() })
    assert.equal((await call()).json.result.window, 'alpha')
    shared.writeFocus({ key: wb.key, name: 'beta', sessionId: 'sb', at: Date.now() })
    assert.equal((await call()).json.result.window, 'beta')
    const health = (await (await fetch(`http://127.0.0.1:${hubPort}/health`)).json()) as any
    assert.equal(health.service, 'vsmcp-hub')
    assert.equal(health.workspace, 'beta')
    assert.equal(health.mode, 'auto')

    // 锁定 alpha：焦点再变也不动
    shared.updateState({ mode: 'manual', selected: wa.key, selectedName: 'alpha' })
    shared.writeFocus({ key: wb.key, name: 'beta', sessionId: 'sb', at: Date.now() })
    assert.equal((await call()).json.result.window, 'alpha')

    // alpha 窗口关了：不改投 beta
    shared.removeWindow('sa')
    const off = await call()
    assert.equal(off.status, 503)
    assert.match(off.json.error.message, /不会改投/)
    assert.equal((await fetch(`http://127.0.0.1:${hubPort}/health`)).status, 503)

    // 登记还在但端口已经没人听（崩溃窗口心跳还没过期）：502，也不改投
    shared.writeWindow(wa)
    await close(A.server)
    const gone = await call()
    assert.equal(gone.status, 502)
    assert.match(gone.json.error.message, /没有改投/)

    // 同一项目多开：拒绝猜
    shared.updateState({ mode: 'auto', selected: null })
    shared.writeWindow(win('beta', pb + 1000, { sessionId: 'sb2' }))
    const dup = await call()
    assert.equal(dup.status, 503)
    assert.match(dup.json.error.message, /2 个窗口/)

    // 非 MCP 路径 404
    assert.equal((await fetch(`http://127.0.0.1:${hubPort}/api/select`)).status, 404)
  } finally {
    await hub.close()
    await close(A.server).catch(() => undefined)
    await close(B.server)
    rmrf(dir)
  }
})

test('Hub 转发：请求发出时定目标，中途切换不影响进行中的请求', async () => {
  const dir = tmpDir('hub-inflight')
  const A = fakeWindow('alpha', { delayMs: 400 })
  const B = fakeWindow('beta')
  const pa = await listen(A.server)
  const pb = await listen(B.server)
  const shared = new SharedDir(dir)
  shared.ensure()
  const hub = new HubServer({ resolveRoute: fixedRoute(shared), version: 'test' })
  const hubPort = await freePort()
  try {
    await hub.listen(hubPort)
    const wa = win('alpha', pa, { sessionId: 'sa' })
    const wb = win('beta', pb, { sessionId: 'sb' })
    shared.writeWindow(wa)
    shared.writeWindow(wb)
    shared.updateState({ mode: 'manual', selected: wa.key })
    const pending = postJson(`http://127.0.0.1:${hubPort}/mcp`, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'write_file' } })
    await sleep(100)
    shared.updateState({ mode: 'manual', selected: wb.key })
    const later = await postJson(`http://127.0.0.1:${hubPort}/mcp`, { jsonrpc: '2.0', id: 8, method: 'ping' })
    assert.equal(later.json.result.window, 'beta')
    const first = await pending
    assert.equal(first.json.result.window, 'alpha', '已经发出的请求仍然交给发出时的目标')
    assert.equal(first.json.result.echo.id, 7)
  } finally {
    await hub.close()
    await close(A.server)
    await close(B.server)
    rmrf(dir)
  }
})

test('Hub 转发：SSE 会话的 /messages 跟着建立时的窗口走', async () => {
  const dir = tmpDir('hub-sse')
  const A = fakeWindow('alpha')
  const B = fakeWindow('beta')
  const pa = await listen(A.server)
  const pb = await listen(B.server)
  const shared = new SharedDir(dir)
  shared.ensure()
  const hub = new HubServer({ resolveRoute: fixedRoute(shared), version: 'test' })
  const hubPort = await freePort()
  const ctrl = new AbortController()
  try {
    await hub.listen(hubPort)
    const wa = win('alpha', pa, { sessionId: 'sa' })
    const wb = win('beta', pb, { sessionId: 'sb' })
    shared.writeWindow(wa)
    shared.writeWindow(wb)
    shared.updateState({ mode: 'manual', selected: wa.key })
    const sse = await fetch(`http://127.0.0.1:${hubPort}/sse`, { signal: ctrl.signal })
    const reader = sse.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    assert.match(first, /sessionId=sess-alpha/)
    await waitFor(() => hub.sseCount === 1)
    // 切到 beta 以后，alpha 的 SSE 会话消息仍然发给 alpha
    shared.updateState({ mode: 'manual', selected: wb.key })
    const r = await fetch(`http://127.0.0.1:${hubPort}/messages?sessionId=sess-alpha`, { method: 'POST', body: '{}' })
    assert.equal(r.status, 202)
    assert.equal(await r.text(), 'alpha')
    assert.deepEqual(A.got, ['sess-alpha'])
    assert.equal((await fetch(`http://127.0.0.1:${hubPort}/messages?sessionId=nope`, { method: 'POST', body: '{}' })).status, 404)
    ctrl.abort()
    await waitFor(() => hub.sseCount === 0)
  } finally {
    ctrl.abort()
    await hub.close()
    await close(A.server)
    await close(B.server)
    rmrf(dir)
  }
})

test('Hub 抢占：只有一个窗口抢到端口；Hub 关掉后另一个下一轮接手', async () => {
  const port = await freePort()
  const route = () => selectTarget([], { mode: 'auto', selected: null }, null, Date.now())
  const sa = new HubServer({ resolveRoute: route, version: 't' })
  const sb = new HubServer({ resolveRoute: route, version: 't' })
  const events: string[] = []
  const ea = new HubElection({ server: sa, port: () => port, intervalMs: 60_000, onAcquire: () => void events.push('a+'), onRelease: () => void events.push('a-') })
  const eb = new HubElection({ server: sb, port: () => port, intervalMs: 60_000, onAcquire: () => void events.push('b+') })
  try {
    assert.equal(await ea.tick(), true)
    assert.equal(await eb.tick(), false)
    assert.equal(eb.portBusy, true)
    assert.equal(ea.isHub, true)
    const h1 = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as any
    assert.equal(h1.instance, sa.instance)
    await ea.stop()
    assert.equal(await eb.tick(), true, 'A 放掉端口后 B 接手')
    const h2 = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as any
    assert.equal(h2.instance, sb.instance)
    assert.notEqual(h1.instance, h2.instance)
    assert.deepEqual(events, ['a+', 'a-', 'b+'])
  } finally {
    await ea.stop()
    await eb.stop()
  }
})

test('Hub 抢占：端口被别的程序占着时谁也当不上 Hub，报 foreign', async () => {
  const dir = tmpDir('hub-foreign')
  const squatter = http.createServer((_req, res) => res.end('not vsmcp'))
  const port = await listen(squatter)
  const shared = new SharedDir(dir)
  shared.ensure()
  const rt = new HubRuntime({
    shared,
    sessionId: 'w1',
    windowName: () => 'alpha',
    hubPort: () => port,
    version: 't',
    autoRecover: () => true,
    tunnel: { createTunnel: () => { throw new Error('不该开隧道') }, describe: () => ({ provider: 'cloudflare', kind: 'quick', fixed: false }) },
    log: () => undefined,
    intervalMs: 60_000,
  })
  try {
    assert.equal(await rt.tick(), false)
    assert.equal(rt.hubStatus().status, 'foreign')
    assert.equal(rt.diagnose().code, 'hub_missing')
  } finally {
    await rt.stop()
    await close(squatter)
    rmrf(dir)
  }
})

class FakeTunnel implements ManagedTunnel {
  url: string | null = null
  running = false
  port = 0
  constructor(private readonly log: string[], private readonly owner: string) {}
  async start(port: number): Promise<string> {
    this.running = true
    this.port = port
    this.url = `https://${this.owner}.example.test`
    this.log.push(`${this.owner}:start:${port}`)
    return this.url
  }
  stop(): void {
    if (this.running) this.log.push(`${this.owner}:stop`)
    this.running = false
    this.url = null
  }
  dispose(): void {}
}

test('Hub 接手：隧道跟着 Hub 走，新 Hub 按共享状态重开隧道', async () => {
  const dir = tmpDir('hub-takeover')
  const port = await freePort()
  const shared = new SharedDir(dir)
  shared.ensure()
  const log: string[] = []
  const make = (sessionId: string, name: string) =>
    new HubRuntime({
      shared,
      sessionId,
      windowName: () => name,
      hubPort: () => port,
      version: 't',
      autoRecover: () => true,
      tunnel: {
        createTunnel: () => new FakeTunnel(log, name),
        describe: () => ({ provider: 'cloudflare', kind: 'quick', fixed: false }),
      },
      log: () => undefined,
      intervalMs: 60_000,
      probePublic: async () => ({ ok: true }),
    })
  const ra = make('wa', 'alpha')
  const rb = make('wb', 'beta')
  try {
    shared.writeWindow(win('alpha', 1, { sessionId: 'wa' }))
    shared.writeWindow(win('beta', 2, { sessionId: 'wb' }))
    shared.updateState({ tunnelWanted: true })
    assert.equal(await ra.tick(), true)
    assert.equal(await rb.tick(), false)
    await ra.supervisor.settle()
    await ra.tick()
    assert.deepEqual(log, [`alpha:start:${port}`], '只有 Hub 窗口开隧道，指向 Hub 端口')
    assert.equal(shared.readHub()?.sessionId, 'wa')
    assert.equal(shared.readTunnel()?.phase, 'connected')
    assert.equal(shared.readTunnel()?.url, 'https://alpha.example.test')
    assert.equal(rb.hubStatus().status, 'other')

    // Hub 窗口关了
    shared.removeWindow('wa')
    await ra.stop()
    assert.deepEqual(log, [`alpha:start:${port}`, 'alpha:stop'])
    assert.equal(shared.readHub(), null)

    // 另一个窗口下一轮接手，并按 tunnelWanted 重开隧道
    assert.equal(await rb.tick(), true)
    await rb.supervisor.settle()
    await rb.tick()
    assert.deepEqual(log.slice(2), [`beta:start:${port}`])
    assert.equal(shared.readHub()?.sessionId, 'wb')
    const t = shared.readTunnel()!
    assert.equal(t.hubSessionId, 'wb')
    assert.equal(t.url, 'https://beta.example.test')
    assert.equal(t.previousUrl, 'https://alpha.example.test', '临时隧道换了 Hub 地址会变，面板要能提示')
    assert.ok(t.urlChangedAt)

    // 任何窗口写 tunnelWanted=false，Hub 下一轮就关隧道
    shared.updateState({ tunnelWanted: false })
    await rb.tick()
    assert.equal(log[log.length - 1], 'beta:stop')
    assert.equal(shared.readTunnel()?.phase, 'off')
  } finally {
    await ra.stop()
    await rb.stop()
    rmrf(dir)
  }
})

test('Hub：手动「恢复连接」请求跨窗口传给 Hub', async () => {
  const dir = tmpDir('hub-manual')
  const port = await freePort()
  const shared = new SharedDir(dir)
  shared.ensure()
  const log: string[] = []
  let clock = Date.now()
  const rt = new HubRuntime({
    shared,
    sessionId: 'wa',
    windowName: () => 'alpha',
    hubPort: () => port,
    version: 't',
    autoRecover: () => true,
    tunnel: { createTunnel: () => new FakeTunnel(log, 'alpha'), describe: () => ({ provider: 'cloudflare', kind: 'quick', fixed: false }) },
    log: () => undefined,
    intervalMs: 60_000,
    now: () => clock,
    probePublic: async () => ({ ok: true }),
  })
  try {
    shared.updateState({ tunnelWanted: true, recoverRequestedAt: 1 })
    await rt.tick()
    await rt.supervisor.settle()
    assert.equal(log.length, 1, '当上 Hub 之前的旧请求不重放')
    clock += 40_000
    shared.updateState({ recoverRequestedAt: clock })
    await rt.tick()
    await rt.supervisor.settle()
    assert.deepEqual(log, [`alpha:start:${port}`, 'alpha:stop', `alpha:start:${port}`])
  } finally {
    await rt.stop()
    rmrf(dir)
  }
})

// 给类型检查用
export type _W = WindowRecord
