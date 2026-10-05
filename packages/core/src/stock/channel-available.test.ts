import { describe, expect, it } from 'vitest'
import { channelAvailable, channelStockRulesSchema, NO_CHANNEL_STOCK_RULES, type ChannelStockRules } from './channel-available'

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

  it('fails closed: an invalid setting or Available tells the Channel 0', () => {
    expect(channelAvailable(5, rules(-2, null))).toBe(0)
    expect(channelAvailable(5, rules(1.5, null))).toBe(0)
    expect(channelAvailable(5, rules(Number.NaN, null))).toBe(0)
    expect(channelAvailable(5, rules(Infinity, null))).toBe(0)
    expect(channelAvailable(5, rules(0, -1))).toBe(0)
    expect(channelAvailable(5, rules(0, 2.5))).toBe(0)
    expect(channelAvailable(5, rules(0, Number.NaN))).toBe(0)
    expect(channelAvailable(5, rules(0, Infinity))).toBe(0)
    expect(channelAvailable(5, { safetyBuffer: undefined, channelLimit: null } as unknown as ChannelStockRules)).toBe(0)
    expect(channelAvailable(5, { safetyBuffer: 0, channelLimit: undefined } as unknown as ChannelStockRules)).toBe(0)
    expect(channelAvailable(Number.NaN, NO_CHANNEL_STOCK_RULES)).toBe(0)
    expect(channelAvailable(2.5, NO_CHANNEL_STOCK_RULES)).toBe(0)
  })

  it('is never negative and never above max(0, Available)', () => {
    const values = [-5, -1, 0, 1, 2, 3, 7, 100]
    const limits = [null, 0, 1, 3, 100]
    for (const available of [...values, 2.5, Number.NaN]) {
      for (const safetyBuffer of [-1, 0, 1, 2, 5, 200, 0.5, Number.NaN]) {
        for (const channelLimit of [...limits, -1, 1.5, Number.NaN]) {
          const told = channelAvailable(available, rules(safetyBuffer, channelLimit))
          expect(Number.isInteger(told)).toBe(true)
          expect(told).toBeGreaterThanOrEqual(0)
          expect(told).toBeLessThanOrEqual(Number.isInteger(available) ? Math.max(0, available) : 0)
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

  it('needs the limit to be given: a missing limit is an error, not "no limit"', () => {
    expect(channelStockRulesSchema.safeParse({ safetyBuffer: 0 }).success).toBe(false)
    expect(channelStockRulesSchema.safeParse({ channelLimit: null }).success).toBe(false)
  })
})
