import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startService, waitUntil } from './processes'
import { killRunProcesses, parseProcessTable, processState, processesOfRun, readPsResult } from './run-processes'

const dir = mkdtempSync(join(tmpdir(), 'hanza-e2e-run-processes-'))

describe('processesOfRun', () => {
  const table = parseProcessTable(
    [
      '  101   101 /usr/bin/node --import file:///x/apps/e2e/src/parent-guard.mjs?run=aaaaaaaaaaaa src/index.ts',
      '  102   101 /usr/bin/node --import file:///x/apps/e2e/src/parent-guard.mjs?run=aaaaaaaaaaaa /x/next-server',
      '  103   103 /usr/bin/node --import file:///x/apps/e2e/src/parent-guard.mjs?run=bbbbbbbbbbbb src/index.ts',
      '  104   104 /usr/bin/node src/index.ts aaaaaaaaaaaa',
      'garbage',
    ].join('\n'),
  )

  it('parses pid, process group and command', () => {
    expect(table).toHaveLength(4)
    expect(table[1]).toMatchObject({ pid: 102, pgid: 101 })
  })

  it('finds only processes carrying the guard of that run, never the id elsewhere on a command line', () => {
    expect(processesOfRun(table, 'aaaaaaaaaaaa').map((entry) => entry.pid)).toEqual([101, 102])
  })
})

describe('readPsResult', () => {
  it('is running with its start time when ps prints one', () => {
    expect(readPsResult({ status: 0, stdout: 'Mon Oct  5 12:00:00 2026  \n' })).toEqual({ kind: 'running', startedAt: 'Mon Oct  5 12:00:00 2026' })
  })

  it('is gone only when ps exits with 1 and prints nothing', () => {
    expect(readPsResult({ status: 1, stdout: '' })).toEqual({ kind: 'gone' })
  })

  it.each([
    ['ps could not be started', { status: null, stdout: '', error: new Error('spawn ps ENOENT') }],
    ['ps timed out or was killed', { status: null, stdout: '' }],
    ['ps failed otherwise', { status: 2, stdout: '' }],
    ['exit 1 with output', { status: 1, stdout: 'something' }],
    ['exit 0 without output', { status: 0, stdout: '' }],
  ])('is unknown when %s', (_case, result) => {
    expect(readPsResult(result)).toEqual({ kind: 'unknown' })
  })
})

describe('processState', () => {
  it('reads a running process and a missing one from the real ps', () => {
    expect(processState(process.pid)).toMatchObject({ kind: 'running', startedAt: expect.stringMatching(/\d{4}/) })
    const exited = spawnSync(process.execPath, ['-e', '0'])
    expect(processState(exited.pid!)).toEqual({ kind: 'gone' })
  })
})

describe('killRunProcesses', () => {
  it('kills the processes of one run and leaves another run’s alone', { timeout: 20_000 }, async () => {
    const start = (runId: string) =>
      startService(runId, ['-e', `console.log('up'); setInterval(() => {}, 1000)`], { cwd: dir, env: process.env, runId, output: join(dir, `${runId}.log`) })
    const doomed = start('d00000000001')
    const survivor = start('5a0000000001')
    try {
      for (const service of [doomed, survivor]) await waitUntil(service, 'up', async () => service.tail().includes('up'), 5_000)
      expect(await killRunProcesses('d00000000001')).toBe(1)
      expect(await doomed.exited).toBe('SIGKILL')
      expect(survivor.exitCode).toBeUndefined()
      expect(await killRunProcesses('d00000000001')).toBe(0)
    } finally {
      await survivor.stop()
    }
  })

  it('kills a recorded service without the marker (next-server renames itself) only while its start time matches', { timeout: 20_000 }, async () => {
    const unmarked = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
    const recorded = unmarked()
    const reused = unmarked()
    const exited = (child: ReturnType<typeof unmarked>) => new Promise((resolve) => child.once('exit', (_code, signal) => resolve(signal)))
    try {
      await expect.poll(() => processState(recorded.pid!).kind).toBe('running')
      const startedAt = (processState(recorded.pid!) as { startedAt: string }).startedAt
      const services = [
        { pid: recorded.pid, startedAt },
        // Same PID as a live process but another start time: a reused PID, not ours.
        { pid: reused.pid, startedAt: 'Thu Jan  1 00:00:00 1970' },
      ]
      expect(await killRunProcesses('e00000000001', services)).toBe(1)
      expect(await exited(recorded)).toBe('SIGKILL')
      expect(processState(reused.pid!).kind).toBe('running')
    } finally {
      reused.kill('SIGKILL')
      recorded.kill('SIGKILL')
    }
  })
})
