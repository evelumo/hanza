import { describe, expect, it } from 'vitest'
import { formatSyncResult } from './sync-summary'

describe('formatSyncResult', () => {
  it('uses Polish labels and keeps unknown keys readable', () => {
    expect(formatSyncResult({ seen: 5, created: 2, brandNew: 1 })).toBe('widziane 5, nowe 2, brandNew 1')
  })

  it('returns null when there is nothing to show', () => {
    expect(formatSyncResult(null)).toBeNull()
    expect(formatSyncResult({})).toBeNull()
  })
})
