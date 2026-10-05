import { describe, expect, it } from 'vitest'
import { createFormatters, formatDateTime, formatMoney, formatNumber } from './format'

const spaces = (value: string) => value.replace(/\s/g, ' ')

describe('formatMoney', () => {
  it('formats the decimal string without going through a float', () => {
    expect(spaces(formatMoney({ amount: '79.98', currency: 'PLN' }, 'pl'))).toBe('79,98 zł')
    expect(spaces(formatMoney({ amount: '79.98', currency: 'PLN' }, 'en'))).toBe('PLN 79.98')
    expect(spaces(formatMoney({ amount: '9007199254740993.01', currency: 'PLN' }, 'pl'))).toContain('9 007 199 254 740 993,01')
    expect(formatMoney({ amount: '9007199254740993.01', currency: 'PLN' }, 'en')).toContain('9,007,199,254,740,993.01')
  })

  it('keeps up to four decimals and pads to the currency minimum', () => {
    expect(spaces(formatMoney({ amount: '12.3456', currency: 'PLN' }, 'pl'))).toBe('12,3456 zł')
    expect(spaces(formatMoney({ amount: '12.3456', currency: 'PLN' }, 'en'))).toBe('PLN 12.3456')
    expect(spaces(formatMoney({ amount: '12.3', currency: 'PLN' }, 'en'))).toBe('PLN 12.30')
  })

  it('falls back to the raw amount for a currency the runtime rejects', () => {
    expect(formatMoney({ amount: '1.50', currency: 'zz' }, 'en')).toBe('1.50 zz')
  })
})

describe('formatNumber', () => {
  it('groups digits the way the locale does', () => {
    expect(formatNumber(1234567, 'en')).toBe('1,234,567')
    expect(spaces(formatNumber(1234567, 'pl'))).toBe('1 234 567')
    expect(formatNumber(-3, 'en')).toBe('-3')
  })
})

describe('formatDateTime', () => {
  it('uses the Warsaw time zone, winter and summer', () => {
    expect(formatDateTime(new Date('2026-01-15T23:30:00Z'), 'pl')).toBe('16.01.2026, 00:30')
    expect(formatDateTime(new Date('2026-07-01T22:30:00Z'), 'pl')).toBe('2.07.2026, 00:30')
  })

  it('writes the English panel day first on a 24-hour clock', () => {
    expect(spaces(formatDateTime(new Date('2026-01-15T23:30:00Z'), 'en'))).toBe('16/01/2026, 00:30')
    expect(spaces(formatDateTime(new Date('2026-07-01T22:30:00Z'), 'en'))).toBe('02/07/2026, 00:30')
  })
})

describe('createFormatters', () => {
  it('binds all three to one locale', () => {
    const format = createFormatters('en')
    expect(format.number(1000)).toBe('1,000')
    expect(spaces(format.money({ amount: '5', currency: 'PLN' }))).toBe('PLN 5.00')
    expect(format.dateTime(new Date('2026-01-15T12:00:00Z'))).toBe('15/01/2026, 13:00')
  })
})
