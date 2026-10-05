import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { freePort, startService, waitUntil } from './processes'

const dir = mkdtempSync(join(tmpdir(), 'hanza-e2e-processes-'))

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('startService', () => {
  it('writes the output to the log file and stop() ends the whole process group', async () => {
    const logFile = join(dir, 'group.log')
    // The shell starts a grandchild, like `next start` does; it must not outlive stop().
    const service = startService('group', '/bin/sh', ['-c', 'sleep 30 & echo "child $!"; wait'], { cwd: dir, env: process.env, logFile })
    await waitUntil(service, 'the child is started', async () => /child \d+/.test(readFileSync(logFile, 'utf8')), 5_000)
    const grandchild = Number(/child (\d+)/.exec(readFileSync(logFile, 'utf8'))![1])
    expect(isRunning(grandchild)).toBe(true)

    await service.stop()

    expect(service.exitCode).not.toBeUndefined()
    await expect.poll(() => isRunning(grandchild)).toBe(false)
    await service.stop()
  })

  it('kills a process that ignores SIGTERM', { timeout: 20_000 }, async () => {
    const service = startService('stubborn', '/bin/sh', ['-c', 'trap "" TERM; echo ready; while true; do sleep 1; done'], {
      cwd: dir,
      env: process.env,
      logFile: join(dir, 'stubborn.log'),
    })
    await waitUntil(service, 'ready', async () => service.tail().includes('ready'), 5_000)
    await service.stop()
    expect(service.exitCode).toBe('SIGKILL')
  })
})

describe('waitUntil', () => {
  it('fails as soon as the service exits, naming what it waited for', async () => {
    const service = startService('quitter', '/bin/sh', ['-c', 'echo bye; exit 3'], { cwd: dir, env: process.env, logFile: join(dir, 'quit.log') })
    await sleep(200)
    await expect(waitUntil(service, 'it is ready', async () => false, 5_000)).rejects.toThrow('quitter exited (3) before it is ready')
    expect(service.tail()).toBe('bye')
  })

  it('fails after the timeout', async () => {
    const service = startService('sleeper', '/bin/sh', ['-c', 'sleep 30'], { cwd: dir, env: process.env, logFile: join(dir, 'sleep.log') })
    try {
      await expect(waitUntil(service, 'never', async () => false, 600)).rejects.toThrow('sleeper: never did not happen within 0.6 s')
    } finally {
      await service.stop()
    }
  })
})

describe('freePort', () => {
  it('returns a port that can be listened on', async () => {
    const port = await freePort()
    const server = createServer()
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve))
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
})
