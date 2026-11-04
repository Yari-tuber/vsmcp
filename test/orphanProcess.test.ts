import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanupOrphanTunnel, orphanProcessDeps } from '../src/tunnel/orphanProcess.js'

test('进程命令行：本机读取本测试 Node 进程，不能把它当成 cloudflared 结束', async () => {
  const command = await orphanProcessDeps.readCommandLine(process.pid)
  assert.ok(command)
  assert.match(command, /node/i)
  const killed = await cleanupOrphanTunnel({
    pid: process.pid, phase: 'off', provider: 'cloudflare', kind: 'quick', url: null,
    fixed: false, restarts: 0, hubSessionId: 'test', updatedAt: 0,
  }, 13340, {
    ...orphanProcessDeps,
    terminate: async () => { assert.fail('不能结束本测试 Node 进程') },
  })
  assert.equal(killed, false)
})
