/**
 * 真的起「窗口 MCP 服务」+ Hub，用 SDK 自己的客户端走 Streamable HTTP 和 SSE 两种传输，
 * 确认升级到最新 SDK 后两条路都通、33 个工具和 annotations 都对、鉴权和端口顺延都按设计走。
 * VS Code 相关的部分（bridge、终端）用假对象，只调用增强工具。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { HttpServer, PortInUseError } from '../src/server/HttpServer.js'
import { HubServer } from '../src/hub/HubServer.js'
import { SharedDir } from '../src/hub/registry.js'
import { selectTarget } from '../src/hub/route.js'
import { WorkspaceTools } from '../src/tools/workspaceTools.js'
import { TOOL_META } from '../src/tools/catalog.js'
import { tmpDir, rmrf, freePort, postJson, win } from './helpers.js'

const DESTRUCTIVE = ['delete_file', 'run_terminal_command', 'write_terminal', 'kill_terminal', 'execute_vscode_command']
const ENHANCED = ['workspace_overview', 'list_directory', 'find_files', 'search_text', 'read_files', 'git_inspect']

function fakeSettings(authToken = '') {
  return { authToken, enableContextPush: false, commandTimeoutMs: 120_000, get: () => undefined } as any
}

function makeWindow(root: string, name: string, settings = fakeSettings()) {
  const tools = new WorkspaceTools({ getRoots: () => [{ name, path: root }], workspaceName: () => name, rgPath: null })
  const pusher = { onPush: () => () => undefined } as any
  return new HttpServer({} as any, pusher, settings, {} as any, tools, () => name)
}

describe('MCP 传输（SDK 最新 1.x）', () => {
  let dirA = ''
  let dirB = ''
  let shared: SharedDir
  let sharedDir = ''
  let a: HttpServer
  let b: HttpServer
  let hub: HubServer
  let hubPort = 0

  before(async () => {
    dirA = fs.realpathSync(tmpDir('alpha'))
    dirB = fs.realpathSync(tmpDir('beta'))
    fs.writeFileSync(path.join(dirA, 'a.txt'), 'alpha file\n')
    fs.writeFileSync(path.join(dirB, 'b.txt'), 'beta file\n')
    sharedDir = tmpDir('shared-mcp')
    shared = new SharedDir(sharedDir)
    shared.ensure()
    a = makeWindow(dirA, 'alpha')
    b = makeWindow(dirB, 'beta')
    const pa = await a.start(await freePort(), false)
    const pb = await b.start(await freePort(), false)
    shared.writeWindow(win('alpha', pa, { sessionId: 'sa', folders: [{ name: 'alpha', path: dirA }] }))
    shared.writeWindow(win('beta', pb, { sessionId: 'sb', folders: [{ name: 'beta', path: dirB }] }))
    hub = new HubServer({ resolveRoute: () => selectTarget(shared.listWindows(), shared.readState(), shared.readFocus(), Date.now()), version: 't' })
    hubPort = await freePort()
    assert.equal(await hub.listen(hubPort), true)
  })

  after(async () => {
    // 每轮测试都会刷新心跳
    await hub.close()
    await a.stop()
    await b.stop()
    rmrf(dirA)
    rmrf(dirB)
    rmrf(sharedDir)
  })

  const lock = (name: 'alpha' | 'beta') => {
    for (const w of shared.listWindows()) shared.writeWindow({ ...w, updatedAt: Date.now() })
    const w = shared.listWindows().find((x) => x.name === name)!
    shared.updateState({ mode: 'manual', selected: w.key, selectedName: name })
  }

  test('Streamable HTTP 经 Hub：initialize、33 个工具、annotations、workspace_overview 跟着锁定走', async () => {
    lock('alpha')
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hubPort}/mcp`)))
    try {
      assert.equal(client.getServerVersion()?.name, 'vsmcp')
      assert.match(client.getInstructions() ?? '', /workspace_overview/)
      const { tools } = await client.listTools()
      assert.equal(tools.length, 33)
      assert.equal(Object.keys(TOOL_META).length, 33)
      for (const t of tools) {
        assert.ok(TOOL_META[t.name], `${t.name} 在 catalog 里`)
        assert.equal(t.annotations?.readOnlyHint, TOOL_META[t.name].annotations.readOnlyHint, `${t.name} readOnlyHint`)
        assert.equal(t.annotations?.destructiveHint, TOOL_META[t.name].annotations.destructiveHint, `${t.name} destructiveHint`)
      }
      const destructive = tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name).sort()
      assert.deepEqual(destructive, [...DESTRUCTIVE].sort())
      for (const n of ENHANCED) assert.equal(tools.find((t) => t.name === n)?.annotations?.readOnlyHint, true, n)
      for (const n of ['get_active_file', 'read_file', 'get_diagnostics', 'find_references', 'get_workspace_info', 'list_terminals', 'read_terminal']) {
        assert.equal(tools.find((t) => t.name === n)?.annotations?.readOnlyHint, true, n)
      }
      for (const n of ['write_file', 'create_file', 'rename_symbol', 'apply_code_action', 'spawn_terminal']) {
        const t = tools.find((x) => x.name === n)!
        assert.equal(t.annotations?.readOnlyHint, false, n)
        assert.equal(t.annotations?.destructiveHint, false, n)
      }

      const ov = await client.callTool({ name: 'workspace_overview', arguments: {} })
      const data = JSON.parse((ov.content as any)[0].text)
      assert.equal(data.workspace, 'alpha')
      assert.equal(data.workspacePath, dirA)

      lock('beta')
      const ov2 = JSON.parse(((await client.callTool({ name: 'workspace_overview', arguments: {} })).content as any)[0].text)
      assert.equal(ov2.workspace, 'beta')
      // 拿着 alpha 的路径去问 beta：拒绝
      const stale = await client.callTool({ name: 'list_directory', arguments: { workspacePath: dirA } })
      assert.equal(stale.isError, true)
      assert.match((stale.content as any)[0].text, /工作区已切换/)
    } finally {
      await client.close()
    }
  })

  test('SSE 经 Hub：连上、列工具、调用 workspace_overview', async () => {
    lock('alpha')
    const client = new Client({ name: 'test-sse', version: '1.0.0' })
    await client.connect(new SSEClientTransport(new URL(`http://127.0.0.1:${hubPort}/sse`)))
    try {
      const { tools } = await client.listTools()
      assert.equal(tools.length, 33)
      const r = JSON.parse(((await client.callTool({ name: 'workspace_overview', arguments: {} })).content as any)[0].text)
      assert.equal(r.workspace, 'alpha')
      // SSE 会话建立后再切换项目，这个会话的后续消息仍发给 alpha（会话在 alpha 窗口里）
      lock('beta')
      const r2 = JSON.parse(((await client.callTool({ name: 'workspace_overview', arguments: {} })).content as any)[0].text)
      assert.equal(r2.workspace, 'alpha')
    } finally {
      await client.close()
    }
  })

  test('网页版 ChatGPT 那样的裸 JSON-RPC：initialize 和 tools/list 直接返回 JSON', async () => {
    lock('beta')
    const init = await postJson(`http://127.0.0.1:${hubPort}/mcp`, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'curl', version: '0' } },
    })
    assert.equal(init.status, 200)
    assert.equal(init.json.result.serverInfo.name, 'vsmcp')
    const list = await postJson(`http://127.0.0.1:${hubPort}/mcp`, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { 'mcp-protocol-version': '2025-06-18' })
    assert.equal(list.json.result.tools.length, 33)
  })
})

test('鉴权：authToken 留空不鉴权；填了就要 Bearer', async () => {
  const dir = fs.realpathSync(tmpDir('auth'))
  const settings = fakeSettings('')
  const s = makeWindow(dir, 'auth', settings)
  const port = await s.start(await freePort(), false)
  try {
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
    assert.equal((await postJson(`http://127.0.0.1:${port}/mcp`, body)).status, 200)
    settings.authToken = 'tok-123'
    assert.equal((await postJson(`http://127.0.0.1:${port}/mcp`, body)).status, 401)
    assert.equal((await postJson(`http://127.0.0.1:${port}/mcp`, body, { Authorization: 'Bearer wrong' })).status, 401)
    assert.equal((await postJson(`http://127.0.0.1:${port}/mcp`, body, { Authorization: 'Bearer tok-123' })).status, 200)
    // /health 不需要鉴权
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200)
  } finally {
    await s.stop()
    rmrf(dir)
  }
})

test('窗口端口：被占用时顺延、跳过 Hub 端口；不顺延时报 PortInUseError', async () => {
  const dir = fs.realpathSync(tmpDir('ports'))
  const s1 = makeWindow(dir, 'p1')
  const s2 = makeWindow(dir, 'p2')
  const s3 = makeWindow(dir, 'p3')
  try {
    const base = await freePort()
    assert.equal(await s1.start(base, false), base)
    const p2 = await s2.start(base, true, [base + 1])
    assert.equal(p2, base + 2, '跳过被占用的 base 和 Hub 端口 base+1')
    await assert.rejects(s3.start(base, false), PortInUseError)
    // 放宽超时：长命令不被 Node 默认的请求超时掐断
    const inner = (s1 as any).httpServer
    assert.equal(inner.requestTimeout, 0)
    assert.equal(inner.timeout, 0)
  } finally {
    await s1.stop()
    await s2.stop()
    await s3.stop()
    rmrf(dir)
  }
})
