import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TerminalManager } from '../src/terminal/TerminalManager.js'
import { isPidAlive } from '../src/hub/registry.js'
import { tmpDir, rmrf, waitFor } from './helpers.js'

test('真实终端：写入命令、读取 UTF-8 stdout/stderr、列出状态并结束进程树', { timeout: 25_000 }, async () => {
  const dir = tmpDir('terminal')
  const manager = new TerminalManager()
  const childPidFile = path.join(dir, 'child.pid')
  let id: string | undefined
  let childPid = 0
  try {
    id = manager.spawn('真实终端测试', undefined, dir).id
    assert.equal(manager.write(id, 'echo vsmcp-terminal-ok'), true)
    await waitFor(() => manager.readOutput(id!)?.output.includes('vsmcp-terminal-ok'), 10_000)
    if (process.platform === 'win32') {
      // 拼接后才出现完整结果，避免把 PowerShell 回显的输入误当成执行成功。
      manager.write(id, "Write-Output ('中文' + '-正常'); [Console]::Error.WriteLine(('错误' + '-正常'))")
      await waitFor(() => {
        const out = manager.readOutput(id!)?.output ?? ''
        return out.includes('中文-正常') && out.includes('错误-正常')
      })
      const childArgs = '-e "setInterval(()=>{},1000)"'
      manager.write(id, `$child = Start-Process -FilePath '${process.execPath.replace(/'/g, "''")}' -ArgumentList '${childArgs}' -WindowStyle Hidden -PassThru; [IO.File]::WriteAllText('${childPidFile.replace(/'/g, "''")}', [string]$child.Id)`)
      await waitFor(() => fs.existsSync(childPidFile))
      childPid = Number(fs.readFileSync(childPidFile, 'utf8'))
      assert.equal(isPidAlive(childPid), true)
    }
    const info = manager.list().find(t => t.id === id)!
    assert.equal(info.alive, true)
    assert.equal(info.cwd, dir)
    const pid = info.pid
    if (process.platform === 'win32') assert.ok(pid)
    assert.equal(manager.kill(id), true)
    if (pid) await waitFor(() => !isPidAlive(pid))
    if (childPid) await waitFor(() => !isPidAlive(childPid))
    assert.equal(manager.write(id, 'echo should-not-run'), false)
    assert.equal(manager.readOutput(id), null)
  } finally {
    if (id) manager.kill(id)
    manager.dispose()
    // 仅在测试失败时兜底回收本测试自己启动的子进程。
    if (childPid && isPidAlive(childPid)) process.kill(childPid)
    rmrf(dir)
  }
})

test('Windows 真实终端：启动命令立即执行，dispose 回收进程', { skip: process.platform !== 'win32', timeout: 15_000 }, async () => {
  const manager = new TerminalManager()
  try {
    const { id } = manager.spawn('启动命令测试', "Write-Output ('首发' + '-正常')")
    await waitFor(() => manager.readOutput(id)?.output.includes('首发-正常'), 10_000)
    const pid = manager.list().find(t => t.id === id)!.pid!
    assert.equal(isPidAlive(pid), true)
    manager.dispose()
    await waitFor(() => !isPidAlive(pid))
    assert.deepEqual(manager.list(), [])
  } finally {
    manager.dispose()
  }
})
