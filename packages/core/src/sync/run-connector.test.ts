import { describe, expect, it } from 'vitest'
import { retryLaterDelay } from './run-connector'

describe('retryLaterDelay', () => {
  it('waits at least 1 s, so Retry-After: 0 or a past date never makes a hot loop', () => {
    expect(retryLaterDelay(0)).toBe(1_000)
    expect(retryLaterDelay(-5_000)).toBe(1_000)
    expect(retryLaterDelay(Number.NaN)).toBe(1_000)
    expect(retryLaterDelay(null)).toBe(1_000)
  })

  it('keeps a delay inside the bounds and caps it at 15 minutes', () => {
    expect(retryLaterDelay(5_000)).toBe(5_000)
    expect(retryLaterDelay(900_000)).toBe(900_000)
    expect(retryLaterDelay(3_600_000)).toBe(900_000)
  })
})
