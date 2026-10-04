import { describe, expect, it } from 'vitest'
import { formatMoney } from './format'

describe('formatMoney', () => {
  it('formats the decimal string without going through a float', () => {
    expect(formatMoney({ amount: '79.98', currency: 'PLN' }).replace(/\s/g, ' ')).toBe('79,98 zł')
    expect(formatMoney({ amount: '9007199254740993.01', currency: 'PLN' })).toContain('9 007 199 254 740 993,01'.replace(/ /g, ' '))
  })

  it('falls back to the raw amount for a currency the runtime rejects', () => {
    expect(formatMoney({ amount: '1.50', currency: 'zz' })).toBe('1.50 zz')
  })
})
