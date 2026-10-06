import { describe, expect, it } from 'vitest'
import { isValidRetentionDays, retentionNeedsConfirmation } from './settings'

describe('retentionNeedsConfirmation', () => {
  it('asks before turning retention on or shortening it, which can erase Buyer data at the next check', () => {
    expect(retentionNeedsConfirmation(null, 30)).toBe(true)
    expect(retentionNeedsConfirmation(90, 30)).toBe(true)
  })

  it('does not ask before lengthening it, turning it off or keeping it', () => {
    expect(retentionNeedsConfirmation(30, 90)).toBe(false)
    expect(retentionNeedsConfirmation(30, null)).toBe(false)
    expect(retentionNeedsConfirmation(30, 30)).toBe(false)
    expect(retentionNeedsConfirmation(null, null)).toBe(false)
  })
})

describe('isValidRetentionDays', () => {
  it('accepts null or whole days from 1 to 3650', () => {
    for (const days of [null, 1, 30, 3650]) expect(isValidRetentionDays(days)).toBe(true)
    for (const days of [0, -1, 3651, 1.5, Number.NaN]) expect(isValidRetentionDays(days)).toBe(false)
  })
})
