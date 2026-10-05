import { describe, expect, it } from 'vitest'
import { ALLOW_REMOTE_REDIS, assertRedisAllowed, isDeadRun, namesFor, newRunId, parseRunRecord, serverOf, type RunRecord } from './run-registry'

const record: RunRecord = {
  runId: '0123456789ab',
  host: 'laptop',
  pid: 7,
  startedAt: 'Mon Oct  5 12:00:00 2026',
  queuePrefix: 'hanza-e2e-0123456789ab',
  database: { name: 'hanza_e2e_0123456789ab', server: '127.0.0.1:5442' },
  ports: [3000, 3001],
  services: [{ name: 'worker', pid: 8 }],
}

describe('namesFor', () => {
  it('derives the queue prefix and database name from a fresh run id', () => {
    const runId = newRunId()
    expect(namesFor(runId)).toEqual({ queuePrefix: `hanza-e2e-${runId}`, database: `hanza_e2e_${runId}` })
  })

  it.each(['', 'ABCDEF012345', '0123456789a', "x'; DROP DATABASE hanza; --"])('rejects the run id %j', (runId) => {
    expect(() => namesFor(runId)).toThrow(/Invalid run id/)
  })
})

describe('isDeadRun', () => {
  const here = (startTime: string | null) => ({ host: 'laptop', startTimeOf: () => startTime })

  it('is dead when its runner is gone', () => {
    expect(isDeadRun(record, here(null))).toBe(true)
  })

  it('is dead when the PID now belongs to a later process', () => {
    expect(isDeadRun(record, here('Mon Oct  5 13:00:00 2026'))).toBe(true)
  })

  it('is alive while its runner runs', () => {
    expect(isDeadRun(record, here(record.startedAt))).toBe(false)
  })

  it('is never judged from another host', () => {
    expect(isDeadRun({ ...record, host: 'ci-runner' }, here(null))).toBe(false)
  })
})

describe('parseRunRecord', () => {
  it('reads a record and rejects anything with an unusable run id', () => {
    expect(parseRunRecord(JSON.stringify(record))).toEqual(record)
    expect(parseRunRecord('not json')).toBeNull()
    expect(parseRunRecord(JSON.stringify({ ...record, runId: '../../etc' }))).toBeNull()
  })
})

describe('assertRedisAllowed', () => {
  it('accepts Redis on this machine', () => {
    for (const url of ['redis://localhost:6389/4', 'redis://127.0.0.1:6389', 'redis://[::1]:6379']) expect(() => assertRedisAllowed(url, {})).not.toThrow()
  })

  it('refuses a remote Redis unless explicitly allowed', () => {
    expect(() => assertRedisAllowed('redis://cache.example.com:6379', {})).toThrow(ALLOW_REMOTE_REDIS)
    expect(() => assertRedisAllowed('redis://cache.example.com:6379', { [ALLOW_REMOTE_REDIS]: '1' })).not.toThrow()
  })
})

describe('serverOf', () => {
  it('names host and port, with the default port when none is given', () => {
    expect(serverOf('postgresql://hanza:secret@127.0.0.1:5442/hanza')).toBe('127.0.0.1:5442')
    expect(serverOf('postgresql://db.local/hanza')).toBe('db.local:5432')
    expect(serverOf('redis://localhost')).toBe('localhost:6379')
  })
})
