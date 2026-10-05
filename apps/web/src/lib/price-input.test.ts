import { describe, expect, it } from 'vitest'
import { parsePriceInput } from './price-input'

describe('parsePriceInput', () => {
  it.each([
    ['45,00', 'PLN', '45.00'],
    ['45.5', 'PLN', '45.5'],
    ['1 234,50', 'PLN', '1234.50'],
    ['1 234,50', 'PLN', '1234.50'],
    ['1,234.50', 'PLN', '1234.50'],
    ['1.234,50', 'EUR', '1234.50'],
    ['1,234,567', 'PLN', '1234567'],
    ['0010', 'PLN', '10'],
    ['1234', 'JPY', '1234'],
    ['1.234', 'KWD', '1.234'],
    ['1,234', 'KWD', '1.234'],
    [' 49,9 ', 'PLN', '49.9'],
  ])('reads %j in %s as %s', (raw, currency, amount) => {
    expect(parsePriceInput(raw, currency)).toEqual({ amount })
  })

  it.each([
    ['1,234', 'PLN'],
    ['1.234', 'PLN'],
    ['1.234', 'EUR'],
    ['1,500', 'JPY'],
  ])('refuses %j in %s as ambiguous', (raw, currency) => {
    expect(parsePriceInput(raw, currency)).toEqual({ error: 'validation.priceAmbiguous' })
  })

  it.each([
    ['45.5', 'JPY'],
    ['1.2345', 'PLN'],
    ['1,2345', 'KWD'],
  ])('refuses %j in %s for its decimal places', (raw, currency) => {
    expect(parsePriceInput(raw, currency)).toEqual({ error: 'validation.priceTooManyDecimals' })
  })

  it.each(['', '0', '0,00', '-1', '1e3', 'abc', '1.', ',5', '1.000.000,5,5', '1,23.4,5', '12,34.50', '1000000000000000'])(
    'refuses %j',
    (raw) => {
      expect(parsePriceInput(raw, 'PLN')).toEqual({ error: 'validation.priceInvalid' })
    },
  )
})
