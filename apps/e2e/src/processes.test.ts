import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { freePort, startService, waitUntil } from './processes'

const dir = mkdtempSync(join(tmpdir(), 'hanza-e2e-processes-'))
const runId = 'abcdef012345'

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const readPids = (file: string) => [...readFileSync(file, 'utf8').matchAll(/pid (\d+)/g)].map((match) => Number(match[1]))

// A Node service that starts a grandchild (like `next start` does) and prints both PIDs.
const withGrandchild = `
  const { spawn } = require('node:child_process')
  const child = spawn('sleep', ['30'], { stdio: 'ignore' })
  console.log('pid ' + process.pid + ' pid ' + child.pid)
  setInterval(() => {}, 1000)`

describe('startService', () => {
  it('logs to the file and stop() ends the whole process group', async () => {
    const logFile = join(dir, 'group.log')
    const service = startService('group', ['-e', withGrandchild], { cwd: dir, env: process.env, runId, output: logFile })
    await waitUntil(service, 'both are started', async () => readPids(logFile).length === 2, 5_000)
    const [, grandchild] = readPids(logFile)
    expect(isRunning(grandchild!)).toBe(true)

    await service.stop()

    expect(service.exitCode).not.toBeUndefined()
    await expect.poll(() => isRunning(grandchild!)).toBe(false)
    await service.stop()
  })

  it('kills a process that ignores SIGTERM', { timeout: 20_000 }, async () => {
    const code = `process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)`
    const service = startService('stubborn', ['-e', code], { cwd: dir, env: process.env, runId, output: join(dir, 'stubborn.log') })
    await waitUntil(service, 'ready', async () => service.tail().includes('ready'), 5_000)
    await service.stop()
    expect(service.exitCode).toBe('SIGKILL')
  })

  it('puts the run id on the command line through the guard preload', async () => {
    const code = `console.log(process.execArgv.join(' ')); setInterval(() => {}, 1000)`
    const service = startService('marked', ['-e', code], { cwd: dir, env: process.env, runId, output: join(dir, 'marked.log') })
    try {
      await waitUntil(service, 'printed', async () => service.tail().includes('--import'), 5_000)
      expect(service.tail()).toContain(`parent-guard.mjs?run=${runId}`)
    } finally {
      await service.stop()
    }
  })
})

describe('the parent guard', () => {
  it('kills a service and its children when the runner is killed with SIGKILL', { timeout: 20_000 }, async () => {
    const logFile = join(dir, 'orphan.log')
    // A stand-in for the runner: it starts a service, then is killed without any chance to clean up.
    const runnerCode = `
      const { startService } = await import(${JSON.stringify(join(import.meta.dirname, 'processes.ts'))})
      startService('orphan', ['-e', ${JSON.stringify(withGrandchild)}], { cwd: ${JSON.stringify(dir)}, env: process.env, runId: '${runId}', output: ${JSON.stringify(logFile)} })
      setInterval(() => {}, 1000)`
    const runner = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', runnerCode], { cwd: import.meta.dirname, stdio: 'inherit' })
    await expect.poll(() => readPids(logFile).length, { timeout: 10_000 }).toBe(2)
    const [service, grandchild] = readPids(logFile)

    runner.kill('SIGKILL')

    await expect.poll(() => isRunning(service!), { timeout: 5_000 }).toBe(false)
    await expect.poll(() => isRunning(grandchild!), { timeout: 5_000 }).toBe(false)
  })

  it('is not armed in a Node child that inherits the preload but not the lifeline (Playwright’s test workers)', async () => {
    const logFile = join(dir, 'unarmed.log')
    const code = `
      const { spawn } = require('node:child_process')
      const child = spawn(process.execPath, [...process.execArgv, '-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      console.log('pid ' + process.pid + ' pid ' + child.pid)
      setInterval(() => {}, 1000)`
    const service = startService('unarmed', ['-e', code], { cwd: dir, env: process.env, runId, output: logFile })
    try {
      await waitUntil(service, 'started', async () => readPids(logFile).length === 2, 5_000)
      await sleep(1_000)
      expect(isRunning(readPids(logFile)[1]!)).toBe(true)
    } finally {
      await service.stop()
    }
  })
})

describe('waitUntil', () => {
  it('fails as soon as the service exits, naming what it waited for', async () => {
    const service = startService('quitter', ['-e', `console.log('bye'); process.exit(3)`], { cwd: dir, env: process.env, runId, output: join(dir, 'quit.log') })
    await service.exited
    await expect(waitUntil(service, 'it is ready', async () => false, 5_000)).rejects.toThrow('quitter exited (3) before it is ready')
    expect(service.tail()).toBe('bye')
  })

  it('fails after the timeout', async () => {
    const service = startService('sleeper', ['-e', 'setInterval(() => {}, 1000)'], { cwd: dir, env: process.env, runId, output: join(dir, 'sleep.log') })
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
