import { describe, expect, it } from 'vitest'
import { centimetresToMillimetres, kilogramsToGrams } from './parcel-input'

describe('centimetresToMillimetres', () => {
  it('reads whole and decimal centimetres, with a dot or a comma', () => {
    expect(centimetresToMillimetres('30')).toBe(300)
    expect(centimetresToMillimetres('30.5')).toBe(305)
    expect(centimetresToMillimetres('30,5')).toBe(305)
    expect(centimetresToMillimetres(' 8 ')).toBe(80)
    expect(centimetresToMillimetres('0.1')).toBe(1)
    expect(centimetresToMillimetres('9999.9')).toBe(99_999)
  })

  it('converts by digits, so no value drifts', () => {
    // 0.7 * 10, 1.1 * 10 and 4.35 * 100 are not whole numbers in floating point.
    expect(centimetresToMillimetres('0.7')).toBe(7)
    expect(centimetresToMillimetres('1.1')).toBe(11)
    expect(centimetresToMillimetres('64.3')).toBe(643)
  })

  it('refuses what is not a length to the millimetre', () => {
    for (const raw of ['', ' ', '0', '0.0', '-5', '30.55', '30.', '.5', '1e3', '3 0', '30cm', '10000', '1,000.5', 'abc']) {
      expect(centimetresToMillimetres(raw), raw).toBeNull()
    }
  })
})

describe('kilogramsToGrams', () => {
  it('reads kilograms to the gram', () => {
    expect(kilogramsToGrams('2')).toBe(2000)
    expect(kilogramsToGrams('0.5')).toBe(500)
    expect(kilogramsToGrams('0,25')).toBe(250)
    expect(kilogramsToGrams('1.234')).toBe(1234)
    expect(kilogramsToGrams('0.001')).toBe(1)
  })

  it('converts by digits, so no value drifts', () => {
    // 0.3 * 1000, 1.005 * 1000 and 8.2 * 1000 are not whole numbers in floating point.
    expect(kilogramsToGrams('0.3')).toBe(300)
    expect(kilogramsToGrams('1.005')).toBe(1005)
    expect(kilogramsToGrams('8.2')).toBe(8200)
    expect(kilogramsToGrams('4.35')).toBe(4350)
  })

  it('refuses what is not a weight to the gram', () => {
    for (const raw of ['', '0', '0.000', '-1', '1.2345', '2kg', '10000', '1.', 'NaN']) {
      expect(kilogramsToGrams(raw), raw).toBeNull()
    }
  })
})
