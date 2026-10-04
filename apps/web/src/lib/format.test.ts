import { describe, expect, it } from 'vitest'
import { formatDateTime, formatMoney } from './format'

describe('formatMoney', () => {
  it('formats the decimal string without going through a float', () => {
    expect(formatMoney({ amount: '79.98', currency: 'PLN' }).replace(/\s/g, ' ')).toBe('79,98 zł')
    expect(formatMoney({ amount: '9007199254740993.01', currency: 'PLN' })).toContain('9 007 199 254 740 993,01'.replace(/ /g, ' '))
  })

  it('keeps up to four decimals and pads to the currency minimum', () => {
    expect(formatMoney({ amount: '12.3456', currency: 'PLN' }).replace(/\s/g, ' ')).toBe('12,3456 zł')
    expect(formatMoney({ amount: '12.3', currency: 'PLN' }).replace(/\s/g, ' ')).toBe('12,30 zł')
  })

  it('falls back to the raw amount for a currency the runtime rejects', () => {
    expect(formatMoney({ amount: '1.50', currency: 'zz' })).toBe('1.50 zz')
  })
})

describe('formatDateTime', () => {
  it('uses the Warsaw time zone, winter and summer', () => {
    expect(formatDateTime(new Date('2026-01-15T23:30:00Z'))).toBe('16.01.2026, 00:30')
    expect(formatDateTime(new Date('2026-07-01T22:30:00Z'))).toBe('2.07.2026, 00:30')
  })
})
