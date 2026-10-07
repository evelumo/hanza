import { describe, expect, it } from 'vitest'
import { earliestSlot } from './limiter'
import { describeRateLimiter } from './limiter-contract'
import { createInMemoryRateLimiter } from './memory'

describe('earliestSlot', () => {
  const rate = { requests: 3, windowMs: 1000 }

  it('is now while the window has room and nothing is reserved ahead', () => {
    expect(earliestSlot([], rate, 5000)).toBe(5000)
    expect(earliestSlot([4200, 4900], rate, 5000)).toBe(5000)
  })

  it('waits for the oldest request that must leave a full window (windows are half-open)', () => {
    // At 5100 the window (4100, 5100] would hold 4200, 4900, 5000 and the new one: wait until 4200 leaves.
    expect(earliestSlot([4200, 4900, 5000], rate, 5100)).toBe(5200)
    expect(earliestSlot([4100, 4900, 5000], rate, 5100)).toBe(5100)
  })

  it('never goes before a reservation already made ahead, so the times stay sorted', () => {
    expect(earliestSlot([4500, 5300], rate, 5000)).toBe(5300)
    // Five reserved: the third newest (5500) must leave the window, so (5500, 6500] holds 5600, 6500 and the new one.
    expect(earliestSlot([4500, 4600, 5500, 5600, 6500], rate, 5000)).toBe(6500)
    expect(earliestSlot([4900, 5000, 5100], rate, 5000)).toBe(5900)
  })
})

describeRateLimiter('in-memory limiter', () => {
  let now = 1_000_000
  let counter = 0
  return {
    limiter: createInMemoryRateLimiter({ now: () => now }),
    advance: async (ms) => {
      now += ms
    },
    now: () => now,
    key: (name) => `${name}-${counter++}`,
    slack: 0,
  }
})

describe('in-memory limiter', () => {
  it('keeps no state between instances', async () => {
    const bucket = { key: 'k', rate: { requests: 1, windowMs: 60_000 } }
    await createInMemoryRateLimiter().reserve([bucket], 0)
    expect(await createInMemoryRateLimiter().reserve([bucket], 0)).toEqual({ granted: true, waitMs: 0 })
  })
})
