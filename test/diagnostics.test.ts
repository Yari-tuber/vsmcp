import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'
import { classify, DiagnosticsRecorder } from '../src/diagnostics/diagnostics.js'
import { selectTarget } from '../src/hub/route.js'
import type { TunnelRecord } from '../src/hub/registry.js'
import { buildPanelState } from '../src/ui/panelState.js'
import { win, tmpDir, rmrf } from './helpers.js'

const now = 1_800_000_000_000
const alpha = win('alpha', 13333, { updatedAt: now })
const ok = selectTarget([alpha], { mode: 'manual', selected: alpha.key }, null, now)
const none = selectTarget([], { mode: 'auto', selected: null }, null, now)
const tun = (o: Partial<TunnelRecord>): TunnelRecord => ({
  phase: 'connected',
  provider: 'cloudflare',
  kind: 'quick',
  url: 'https://x.trycloudflare.com',
  fixed: false,
  restarts: 0,
  hubSessionId: 's',
  updatedAt: now,
  publicProbe: { ok: true, at: now - 1000 },
  ...o,
})
const base = { hub: 'self' as const, hubPort: 13340, tunnelWanted: true, now }

test('分层自检：不把「项目没打开」和「网络断了」混在一起', () => {
  assert.equal(classify({ ...base, route: none, tunnel: tun({}) }).code, 'workspace_unavailable')
  assert.equal(classify({ ...base, hub: 'foreign', route: ok, tunnel: null }).code, 'hub_missing')
  assert.equal(classify({ ...base, route: ok, tunnelWanted: false, tunnel: null }).code, 'tunnel_off')
  assert.equal(classify({ ...base, route: ok, tunnel: tun({ phase: 'starting' }) }).code, 'tunnel_starting')
  assert.equal(classify({ ...base, route: ok, tunnel: tun({ phase: 'disconnected' }) }).code, 'tunnel_disconnected')
  const err = classify({ ...base, route: ok, tunnel: tun({ phase: 'error', errorCode: 'cloudflared_missing', lastError: '没装 cloudflared' }) })
  assert.equal(err.code, 'tunnel_error')
  assert.match(err.action, /安装 cloudflared/)
  assert.equal(classify({ ...base, route: ok, tunnel: tun({ publicProbe: { ok: false, at: now - 1000 } }) }).code, 'public_probe_failed')
  assert.equal(classify({ ...base, route: ok, tunnel: tun({ publicProbe: null }) }).code, 'checking_public')
  const healthy = classify({ ...base, route: ok, tunnel: tun({}) })
  assert.equal(healthy.code, 'healthy')
  assert.deepEqual(healthy.layers, { workspace: 'ok', hub: 'ok', tunnel: 'ok', public: 'ok' })
})

test('自检记录：状态变化才追加事件', () => {
  const dir = tmpDir('diag')
  try {
    const rec = new DiagnosticsRecorder(path.join(dir, 'd.json'), path.join(dir, 'e.jsonl'))
    const d1 = classify({ ...base, route: ok, tunnel: tun({}) })
    const d2 = classify({ ...base, route: ok, tunnel: tun({ phase: 'disconnected' }) })
    assert.equal(rec.record(d1), true)
    assert.equal(rec.record(d1), false)
    assert.equal(rec.record(d2), true)
    const lines = fs.readFileSync(path.join(dir, 'e.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'd.json'), 'utf8')).diagnosis.code, 'tunnel_disconnected')
  } finally {
    rmrf(dir)
  }
})

test('面板数据：地址带 /mcp、地址变了要提醒、Hub 还没写状态时显示「正在建立」', () => {
  const inputs = {
    version: '2.0.0',
    now,
    self: { sessionId: alpha.sessionId, name: 'alpha', port: 13333, hasFolders: true, agents: 0, key: alpha.key },
    route: ok,
    windows: [alpha],
    hub: { status: 'self' as const, record: null },
    hubPort: 13340,
    tunnelWanted: true,
    tunnel: tun({ previousUrl: 'https://old.trycloudflare.com', urlChangedAt: now - 5000 }),
    tunnelDefaults: { provider: 'cloudflare' as const, kind: 'quick' as const, fixed: false },
    ackedUrl: null,
    diagnosis: classify({ ...base, route: ok, tunnel: tun({}) }),
    authEnabled: false,
    tokenSet: false,
    ripgrep: true,
  }
  const s = buildPanelState(inputs)
  assert.equal(s.tunnel.url, 'https://x.trycloudflare.com/mcp')
  assert.equal(s.tunnel.urlChanged, true)
  assert.equal(s.route.target?.isSelf, true)
  assert.equal(s.projects[0].isTarget, true)
  assert.equal(s.projects[0].isHub, true)
  assert.equal(s.local.hubUrl, 'http://127.0.0.1:13340/mcp')
  assert.equal(buildPanelState({ ...inputs, ackedUrl: 'https://x.trycloudflare.com/mcp' }).tunnel.urlChanged, false)
  const stale = buildPanelState({ ...inputs, tunnel: tun({ updatedAt: now - 60_000 }) })
  assert.equal(stale.tunnel.phase, 'starting')
  assert.equal(stale.tunnel.url, null)
  assert.equal(buildPanelState({ ...inputs, tunnelWanted: false }).tunnel.phase, 'off')
})
