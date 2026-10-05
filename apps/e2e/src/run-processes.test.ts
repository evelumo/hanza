import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startService, waitUntil } from './processes'
import { killRunProcesses, parseProcessTable, processStartTime, processesOfRun } from './run-processes'

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

describe('processStartTime', () => {
  it('is set for a running process and null for none', () => {
    expect(processStartTime(process.pid)).toMatch(/\d{4}/)
    expect(processStartTime(2 ** 22 + 12_345)).toBeNull()
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
})
