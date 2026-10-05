import { describe, expect, it } from 'vitest'
import { channelAvailable, channelStockRulesSchema, NO_CHANNEL_STOCK_RULES } from './channel-available'

const rules = (safetyBuffer: number, channelLimit: number | null) => ({ safetyBuffer, channelLimit })

describe('channelAvailable', () => {
  it('without rules is max(0, Available)', () => {
    expect(channelAvailable(7, NO_CHANNEL_STOCK_RULES)).toBe(7)
    expect(channelAvailable(0, NO_CHANNEL_STOCK_RULES)).toBe(0)
    expect(channelAvailable(-3, NO_CHANNEL_STOCK_RULES)).toBe(0)
  })

  it('takes the Safety buffer off Available', () => {
    expect(channelAvailable(10, rules(2, null))).toBe(8)
  })

  it('is 0 when the Safety buffer is as large as Available or larger', () => {
    expect(channelAvailable(2, rules(2, null))).toBe(0)
    expect(channelAvailable(1, rules(5, null))).toBe(0)
    expect(channelAvailable(-4, rules(5, null))).toBe(0)
  })

  it('caps at the Channel limit', () => {
    expect(channelAvailable(10, rules(0, 4))).toBe(4)
    expect(channelAvailable(10, rules(0, 0))).toBe(0)
  })

  it('is Available when the Channel limit is larger than Available', () => {
    expect(channelAvailable(3, rules(0, 50))).toBe(3)
    expect(channelAvailable(-2, rules(0, 50))).toBe(0)
  })

  it('applies the buffer first, then the limit', () => {
    expect(channelAvailable(10, rules(3, 5))).toBe(5)
    expect(channelAvailable(6, rules(3, 5))).toBe(3)
  })

  it('reads settings outside their range as no buffer and no limit', () => {
    expect(channelAvailable(5, rules(-2, null))).toBe(5)
    expect(channelAvailable(5, rules(1.5, null))).toBe(5)
    expect(channelAvailable(5, rules(0, -1))).toBe(5)
    expect(channelAvailable(5, rules(Number.NaN, Number.NaN))).toBe(5)
  })

  it('is never negative and never above max(0, Available)', () => {
    const values = [-5, -1, 0, 1, 2, 3, 7, 100]
    const limits = [null, 0, 1, 3, 100]
    for (const available of values) {
      for (const safetyBuffer of [-1, 0, 1, 2, 5, 200]) {
        for (const channelLimit of limits) {
          const told = channelAvailable(available, rules(safetyBuffer, channelLimit))
          expect(Number.isInteger(told)).toBe(true)
          expect(told).toBeGreaterThanOrEqual(0)
          expect(told).toBeLessThanOrEqual(Math.max(0, available))
        }
      }
    }
  })
})

describe('channelStockRulesSchema', () => {
  it('accepts whole numbers from 0 to 1,000,000 and a null limit', () => {
    expect(channelStockRulesSchema.safeParse(rules(0, null)).success).toBe(true)
    expect(channelStockRulesSchema.safeParse(rules(1_000_000, 1_000_000)).success).toBe(true)
  })

  it('rejects negative, fractional and too large values', () => {
    expect(channelStockRulesSchema.safeParse(rules(-1, null)).success).toBe(false)
    expect(channelStockRulesSchema.safeParse(rules(1.5, null)).success).toBe(false)
    expect(channelStockRulesSchema.safeParse(rules(0, -1)).success).toBe(false)
    expect(channelStockRulesSchema.safeParse(rules(0, 1_000_001)).success).toBe(false)
  })
})
