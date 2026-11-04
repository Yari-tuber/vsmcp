import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectTarget } from '../src/hub/route.js'
import { SharedDir, workspaceKey, ONLINE_TTL_MS } from '../src/hub/registry.js'
import type { RouteState, FocusRecord } from '../src/hub/registry.js'
import { win, tmpDir, rmrf } from './helpers.js'

const now = 1_800_000_000_000
const auto: RouteState = { mode: 'auto', selected: null }
const focusOn = (w: { key: string; name: string; sessionId: string }, at = now - 1000): FocusRecord => ({ key: w.key, name: w.name, sessionId: w.sessionId, at })

test('自动跟随：跟最后获得焦点的窗口走', () => {
  const a = win('alpha', 13333, { updatedAt: now, focusedAt: now - 5000 })
  const b = win('beta', 13334, { updatedAt: now, focusedAt: now - 1000 })
  assert.equal(selectTarget([a, b], auto, focusOn(a), now).target?.name, 'alpha')
  assert.equal(selectTarget([a, b], auto, focusOn(b), now).target?.name, 'beta')
  const r = selectTarget([a, b], auto, focusOn(b), now)
  assert.equal(r.code, 'ok')
  assert.equal(r.source, 'focus')
  assert.equal(r.mode, 'auto')
})

test('自动跟随：还没有焦点记录时用在线窗口里最近获得过焦点的', () => {
  const a = win('alpha', 13333, { updatedAt: now, focusedAt: now - 5000 })
  const b = win('beta', 13334, { updatedAt: now, focusedAt: now - 1000 })
  const r = selectTarget([a, b], auto, null, now)
  assert.equal(r.target?.name, 'beta')
  assert.equal(r.source, 'initial')
})

test('锁定：切换焦点不影响目标', () => {
  const a = win('alpha', 13333, { updatedAt: now })
  const b = win('beta', 13334, { updatedAt: now })
  const manual: RouteState = { mode: 'manual', selected: a.key, selectedName: 'alpha' }
  const r = selectTarget([a, b], manual, focusOn(b, now), now)
  assert.equal(r.target?.name, 'alpha')
  assert.equal(r.mode, 'manual')
  assert.equal(r.source, 'manual')
})

test('锁定的项目离线：报错，不改投别的项目', () => {
  const b = win('beta', 13334, { updatedAt: now })
  const aKey = workspaceKey([{ path: '/proj/alpha' }])
  const r = selectTarget([b], { mode: 'manual', selected: aKey, selectedName: 'alpha' }, focusOn(b, now), now)
  assert.equal(r.target, null)
  assert.equal(r.code, 'offline')
  assert.match(r.reason ?? '', /alpha/)
  assert.match(r.reason ?? '', /不会改投/)
})

test('自动跟随的目标关了 / 崩了：报错，不自己改投别的项目', () => {
  const a = win('alpha', 13333, { updatedAt: now })
  const b = win('beta', 13334, { updatedAt: now })
  const r = selectTarget([b], auto, focusOn(a), now)
  assert.equal(r.target, null)
  assert.equal(r.code, 'offline')
  assert.match(r.reason ?? '', /不会改投/)
  // 用户点了 beta 窗口（焦点记录更新）后就跟过去
  assert.equal(selectTarget([b], auto, focusOn(b, now), now).target?.name, 'beta')
})

test('同一工作区多开：拒绝猜', () => {
  const a1 = win('alpha', 13333, { updatedAt: now, sessionId: 's1' })
  const a2 = win('alpha', 13335, { updatedAt: now, sessionId: 's2' })
  const b = win('beta', 13334, { updatedAt: now })
  const r = selectTarget([a1, a2, b], auto, focusOn(a1), now)
  assert.equal(r.target, null)
  assert.equal(r.code, 'duplicate')
  assert.equal(r.duplicates, 2)
  assert.match(r.reason ?? '', /2 个窗口/)
  const m = selectTarget([a1, a2, b], { mode: 'manual', selected: a1.key }, null, now)
  assert.equal(m.code, 'duplicate')
})

test('心跳过期（10 秒）就算离线', () => {
  const a = win('alpha', 13333, { updatedAt: now - ONLINE_TTL_MS - 1 })
  const b = win('beta', 13334, { updatedAt: now - 2000 })
  const r = selectTarget([a, b], { mode: 'manual', selected: a.key }, null, now)
  assert.equal(r.code, 'offline')
  assert.deepEqual(r.online.map((w) => w.name), ['beta'])
  // 刚好 10 秒内还算在线
  const a2 = { ...a, updatedAt: now - ONLINE_TTL_MS }
  assert.equal(selectTarget([a2, b], { mode: 'manual', selected: a.key }, null, now).target?.name, 'alpha')
})

test('空窗口（没有项目文件夹）不当目标', () => {
  const empty = win('（空窗口）', 13335, { folders: [], updatedAt: now, focusedAt: now })
  const a = win('alpha', 13333, { updatedAt: now, focusedAt: now - 100 })
  const r = selectTarget([empty, a], auto, null, now)
  assert.equal(r.target?.name, 'alpha')
  assert.equal(r.online.length, 1)
  assert.equal(selectTarget([empty], auto, null, now).code, 'no_windows')
})

test('工作区 key：路径大小写、斜杠方向、末尾斜杠、多根顺序都不影响', () => {
  assert.equal(workspaceKey([{ path: 'E:\\Proj\\A\\' }]), workspaceKey([{ path: 'e:/proj/a' }]))
  assert.equal(workspaceKey([{ path: '/x' }, { path: '/y' }]), workspaceKey([{ path: '/y' }, { path: '/x' }]))
  assert.notEqual(workspaceKey([{ path: '/x' }]), workspaceKey([{ path: '/x' }, { path: '/y' }]))
})

test('共享目录：登记、状态原子写、焦点、清理死窗口', () => {
  const dir = tmpDir('shared')
  try {
    const s = new SharedDir(dir)
    s.ensure()
    const a = win('alpha', 13333, { updatedAt: now })
    const dead = win('ghost', 13336, { updatedAt: now - 10 * ONLINE_TTL_MS, pid: 999_999_99 })
    s.writeWindow(a)
    s.writeWindow(dead)
    assert.equal(s.listWindows().length, 2)
    assert.deepEqual(s.readState(), { mode: 'auto', selected: null, tunnelWanted: false })
    s.updateState({ mode: 'manual', selected: a.key, selectedName: 'alpha' })
    s.updateState({ tunnelWanted: true })
    const st = s.readState()
    assert.equal(st.mode, 'manual')
    assert.equal(st.selected, a.key)
    assert.equal(st.tunnelWanted, true)
    s.writeFocus(focusOn(a))
    assert.equal(s.readFocus()?.key, a.key)
    const removed = s.cleanupStale(now, (pid) => pid === process.pid)
    assert.deepEqual(removed, [dead.sessionId])
    assert.deepEqual(s.listWindows().map((w) => w.name), ['alpha'])
    s.removeWindow(a.sessionId)
    assert.equal(s.listWindows().length, 0)
  } finally {
    rmrf(dir)
  }
})
