import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, initialPolicyState, POLICY, type Observation, type PolicyState } from '../src/tunnel/recoveryPolicy.js'
import { TunnelSupervisor, type ManagedTunnel } from '../src/tunnel/TunnelSupervisor.js'

const S = 1000
const base = (o: Partial<Observation>): Observation => ({
  now: 0,
  wanted: true,
  autoRecover: true,
  alive: true,
  starting: false,
  connected: true,
  startedAt: 0,
  manualRequested: false,
  blocked: false,
  ...o,
})

test('退避策略：第一次开外网立即启动', () => {
  const d = decide(base({ now: 1000, alive: false, connected: false, startedAt: null }), initialPolicyState())
  assert.equal(d.action, 'start')
  assert.equal(d.state.lastRestartAt, 1000)
  assert.equal(d.state.cooldownMs, POLICY.cooldownInitialMs)
})

test('退避策略：启动宽限 90 秒、断开满 60 秒才重建', () => {
  let st: PolicyState = { cooldownMs: 120 * S, lastRestartAt: 0, offlineSince: null }
  // 启动 30 秒时断开，到 90 秒（宽限期）前都不动
  let d = decide(base({ now: 30 * S, connected: false }), st)
  assert.equal(d.action, 'none')
  st = d.state
  assert.equal(st.offlineSince, 30 * S)
  d = decide(base({ now: 89 * S, connected: false }), st)
  assert.equal(d.action, 'none')
  // 90 秒宽限过了但只断了 60 秒不到，冷却 120 秒也没到
  d = decide(base({ now: 100 * S, connected: false }), d.state)
  assert.equal(d.action, 'none')
  // 120 秒：宽限过了、断了 90 秒、冷却也到了
  d = decide(base({ now: 120 * S, connected: false }), d.state)
  assert.equal(d.action, 'restart')
  assert.equal(d.state.cooldownMs, 240 * S)
})

test('退避策略：断开没满 60 秒不重建（即使宽限和冷却都过了）', () => {
  const st: PolicyState = { cooldownMs: 120 * S, lastRestartAt: 0, offlineSince: 500 * S }
  assert.equal(decide(base({ now: 559 * S, connected: false }), st).action, 'none')
  assert.equal(decide(base({ now: 560 * S, connected: false }), st).action, 'restart')
})

test('退避策略：冷却 120 → 240 → 480 → 600 封顶，连上后回到 120', () => {
  let st = initialPolicyState()
  st = { ...st, lastRestartAt: 0 }
  let now = 0
  const seen: number[] = []
  for (let i = 0; i < 5; i++) {
    // 进程退出（比如网络不通，启动失败），冷却到了就重建
    let d = decide(base({ now, alive: false, connected: false, startedAt: null }), st)
    while (d.action === 'none') {
      now += 10 * S
      d = decide(base({ now, alive: false, connected: false, startedAt: null }), d.state)
    }
    assert.equal(d.action, 'start')
    seen.push(d.state.cooldownMs / S)
    st = d.state
  }
  assert.deepEqual(seen, [240, 480, 600, 600, 600])
  // 连上了：冷却回到 120
  const d = decide(base({ now: now + 5 * S, startedAt: now }), st)
  assert.equal(d.action, 'none')
  assert.equal(d.state.cooldownMs, 120 * S)
})

test('退避策略：手动恢复距上次重建至少 30 秒', () => {
  const st: PolicyState = { cooldownMs: 120 * S, lastRestartAt: 100 * S, offlineSince: null }
  const early = decide(base({ now: 110 * S, manualRequested: true }), st)
  assert.equal(early.action, 'none')
  assert.equal(early.consumedManual, false)
  assert.equal(early.nextRetryAt, 130 * S)
  const ok = decide(base({ now: 130 * S, manualRequested: true }), st)
  assert.equal(ok.action, 'restart')
  assert.equal(ok.consumedManual, true)
  // 进程已经没了：手动就是重新启动
  assert.equal(decide(base({ now: 130 * S, manualRequested: true, alive: false }), st).action, 'start')
})

test('退避策略：关外网就停；不可恢复的错误只等手动；自动恢复可关', () => {
  assert.equal(decide(base({ wanted: false }), initialPolicyState()).action, 'stop')
  assert.equal(decide(base({ wanted: false, alive: false }), initialPolicyState()).action, 'none')
  const st: PolicyState = { cooldownMs: 120 * S, lastRestartAt: 0, offlineSince: null }
  assert.equal(decide(base({ now: 999 * S, alive: false, blocked: true }), st).action, 'none')
  assert.equal(decide(base({ now: 999 * S, alive: false, blocked: true, manualRequested: true }), st).action, 'start')
  assert.equal(decide(base({ now: 999 * S, alive: false, autoRecover: false }), st).action, 'none')
  assert.equal(decide(base({ now: 999 * S, starting: true, alive: false }), st).action, 'none')
})

// ---------------- 看护器（假隧道 + 假时钟） ----------------

class FakeTunnel implements ManagedTunnel {
  static created: FakeTunnel[] = []
  url: string | null = null
  running = false
  connections = 1
  constructor(private readonly nextUrl: string, private readonly fail = false) {
    FakeTunnel.created.push(this)
  }
  async start(): Promise<string> {
    this.running = true
    if (this.fail) {
      this.running = false
      throw new Error('网络不通')
    }
    this.url = this.nextUrl
    return this.nextUrl
  }
  stop(): void {
    this.running = false
    this.url = null
  }
  dispose(): void {}
  async readyConnections(): Promise<number | null> {
    return this.connections
  }
}

test('看护器：开 → 连上 → 断开超过宽限和 60 秒 → 自动重建，临时地址变了会记下来', async () => {
  FakeTunnel.created = []
  let clock = 0
  let n = 0
  const sup = new TunnelSupervisor({
    createTunnel: () => new FakeTunnel(`https://t${++n}.trycloudflare.com`),
    describe: () => ({ provider: 'cloudflare', kind: 'quick', fixed: false }),
    now: () => clock,
  })
  assert.equal(sup.status().phase, 'off')
  sup.setWanted(true)
  await sup.tick(13340)
  await sup.settle()
  assert.equal(FakeTunnel.created.length, 1)
  await sup.tick(13340)
  assert.equal(sup.status().phase, 'connected')
  assert.equal(sup.status().url, 'https://t1.trycloudflare.com')

  // 边缘连接掉了
  FakeTunnel.created[0].connections = 0
  for (clock = 10 * S; clock < 150 * S; clock += 5 * S) await sup.tick(13340)
  await sup.settle()
  assert.equal(FakeTunnel.created.length, 2, '断开满 60 秒、过了 90 秒宽限、冷却到期后应该重建一次')
  await sup.tick(13340)
  const st = sup.status()
  assert.equal(st.phase, 'connected')
  assert.equal(st.url, 'https://t2.trycloudflare.com')
  assert.equal(st.previousUrl, 'https://t1.trycloudflare.com')
  assert.equal(st.restarts, 1)
  assert.ok(st.urlChangedAt)

  // 关外网：隧道停掉
  sup.setWanted(false)
  await sup.tick(13340)
  assert.equal(sup.status().phase, 'off')
  assert.equal(FakeTunnel.created[1].running, false)
})

test('看护器：启动失败按冷却退避重试，并报告错误', async () => {
  FakeTunnel.created = []
  let clock = 0
  const sup = new TunnelSupervisor({
    createTunnel: () => new FakeTunnel('x', true),
    describe: () => ({ provider: 'cloudflare', kind: 'quick', fixed: false }),
    now: () => clock,
  })
  sup.setWanted(true)
  await sup.tick(1)
  await sup.settle()
  assert.equal(sup.status().phase, 'error')
  assert.equal(sup.status().lastError, '网络不通')
  for (clock = 5 * S; clock < 119 * S; clock += 5 * S) await sup.tick(1)
  assert.equal(FakeTunnel.created.length, 1, '冷却 120 秒内不重试')
  clock = 121 * S
  await sup.tick(1)
  await sup.settle()
  assert.equal(FakeTunnel.created.length, 2)
  await sup.tick(1)
  assert.equal(sup.status().nextRetryAt, clock + 240 * S, '第二次失败后冷却翻倍到 240 秒')
})

test('看护器：手动恢复立即重建（距上次至少 30 秒）', async () => {
  FakeTunnel.created = []
  let clock = 0
  const sup = new TunnelSupervisor({
    createTunnel: () => new FakeTunnel('https://a.trycloudflare.com'),
    describe: () => ({ provider: 'cloudflare', kind: 'quick', fixed: false }),
    now: () => clock,
  })
  sup.setWanted(true)
  await sup.tick(1)
  await sup.settle()
  clock = 10 * S
  sup.requestManual()
  await sup.tick(1)
  assert.equal(FakeTunnel.created.length, 1, '10 秒内的手动请求先挂着')
  clock = 31 * S
  await sup.tick(1)
  await sup.settle()
  assert.equal(FakeTunnel.created.length, 2)
  assert.equal(FakeTunnel.created[0].running, false)
})
