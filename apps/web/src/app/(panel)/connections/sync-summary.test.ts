import { describe, expect, it } from 'vitest'
import { translatorFor } from '@/i18n/testing'
import { formatSyncResult } from './sync-summary'

describe('formatSyncResult', () => {
  it('uses the labels of the locale and keeps unknown keys readable', () => {
    const result = { seen: 5, created: 2, brandNew: 1 }
    expect(formatSyncResult(result, translatorFor('en'), 'en')).toBe('seen 5, new 2, brandNew 1')
    expect(formatSyncResult(result, translatorFor('pl'), 'pl')).toBe('widziane 5, nowe 2, brandNew 1')
  })

  it('formats the counts with the locale', () => {
    expect(formatSyncResult({ seen: 12345 }, translatorFor('en'), 'en')).toBe('seen 12,345')
    expect(formatSyncResult({ seen: 12345 }, translatorFor('pl'), 'pl')?.replace(/\s/g, ' ')).toBe('widziane 12 345')
  })

  it('returns null when there is nothing to show', () => {
    expect(formatSyncResult(null, translatorFor(), 'en')).toBeNull()
    expect(formatSyncResult({}, translatorFor(), 'en')).toBeNull()
  })
})
