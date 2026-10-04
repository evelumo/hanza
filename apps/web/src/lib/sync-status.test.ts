import { describe, expect, it } from 'vitest'
import { isSyncRunning, syncStatus } from './sync-status'

const t = (minute: number) => new Date(Date.UTC(2026, 9, 4, 12, minute))
const blank = { lastStartedAt: null, lastFinishedAt: null, lastSucceededAt: null, lastErrorKind: null }

describe('syncStatus', () => {
  it('is idle for a stream that never ran', () => {
    expect(syncStatus(blank)).toBe('idle')
    expect(isSyncRunning(blank)).toBe(false)
  })

  it('is running while a run started and has not finished', () => {
    expect(syncStatus({ ...blank, lastStartedAt: t(1) })).toBe('running')
    expect(syncStatus({ ...blank, lastStartedAt: t(5), lastFinishedAt: t(2) })).toBe('running')
  })

  it('is idle for a run that finished without a Channel call', () => {
    expect(syncStatus({ ...blank, lastStartedAt: t(1), lastFinishedAt: t(2) })).toBe('idle')
  })

  it('is succeeded after a successful run, even while the next one is in flight', () => {
    expect(syncStatus({ ...blank, lastStartedAt: t(1), lastFinishedAt: t(2), lastSucceededAt: t(2) })).toBe('succeeded')
    expect(syncStatus({ ...blank, lastStartedAt: t(5), lastFinishedAt: t(2), lastSucceededAt: t(2) })).toBe('succeeded')
  })

  it('is failed when the last Channel run failed', () => {
    expect(syncStatus({ ...blank, lastStartedAt: t(1), lastFinishedAt: t(2), lastErrorKind: 'transient' })).toBe('failed')
  })
})
