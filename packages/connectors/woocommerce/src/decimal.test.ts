import { moneySchema } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { addDecimal, divideDecimal, MAX_DECIMAL_LENGTH, toMoneyAmount } from './decimal'

describe('what counts as a decimal', () => {
  it.each(['0', '7', '0.00', '129.99', '000.5', '12345678901234567890.123456789'])('%s does', (value) => {
    expect(addDecimal(value, '0')).not.toBeNull()
    expect(divideDecimal(value, 1, 9)).not.toBeNull()
  })

  it.each(['', ' ', '-1', '+1', '.5', '5.', '1,5', '1e3', '1.2.3', ' 1', '1 ', 'NaN', '0x10', '१'])('%j does not', (value) => {
    expect(addDecimal(value, '0')).toBeNull()
    expect(addDecimal('0', value)).toBeNull()
    expect(divideDecimal(value, 1)).toBeNull()
    expect(toMoneyAmount(value)).toBeNull()
  })

  it('nor does a number longer than any amount is, however well formed: a shop cannot hand over megabytes of digits', () => {
    const longest = `${'9'.repeat(MAX_DECIMAL_LENGTH - 5)}.9999`
    expect(longest).toHaveLength(MAX_DECIMAL_LENGTH)
    expect(addDecimal(longest, '0')).toBe(longest)
    for (const tooLong of [`${longest}9`, `0${longest}`, '1'.repeat(5_000_000), `0.${'0'.repeat(5_000_000)}`]) {
      expect(addDecimal(tooLong, '1')).toBeNull()
      expect(addDecimal('1', tooLong)).toBeNull()
      expect(divideDecimal(tooLong, 3)).toBeNull()
      expect(toMoneyAmount(tooLong)).toBeNull()
    }
  })
})

describe('addDecimal', () => {
  it.each([
    ['126.13', '29.01', '155.14'],
    ['40.64', '9.35', '49.99'],
    ['0.00', '0.00', '0.00'],
    ['0', '0', '0'],
    // A carry through every digit.
    ['9.99', '0.01', '10.00'],
    ['999.999', '0.001', '1000.000'],
    ['99', '1', '100'],
    // The longer fraction decides how many digits the sum has.
    ['1.5', '2.25', '3.75'],
    ['1', '0.0001', '1.0001'],
    ['1.50', '1.5', '3.00'],
    // Zeros in front are not kept.
    ['007.50', '0.5', '8.00'],
    // Far beyond what a float holds exactly.
    ['12345678901234567890.12', '0.01', '12345678901234567890.13'],
    ['0.1', '0.2', '0.3'],
  ])('%s + %s = %s', (a, b, sum) => {
    expect(addDecimal(a, b)).toBe(sum)
    expect(addDecimal(b, a)).toBe(sum)
  })

  it('is null for anything that is not a non-negative decimal string', () => {
    expect(addDecimal('-1.00', '2.00')).toBeNull()
    expect(addDecimal('1.00', '')).toBeNull()
    expect(addDecimal('1,00', '2')).toBeNull()
  })
})

describe('divideDecimal', () => {
  it.each([
    // An amount in cents that divides evenly stays an amount in cents.
    ['155.14', 2, '77.57'],
    ['149.97', 3, '49.99'],
    ['100.00', 4, '25.00'],
    ['100.00', 1, '100.00'],
    ['100', 4, '25'],
    ['100', 8, '12.5'],
    ['0.00', 7, '0.00'],
    ['0', 3, '0'],
    // Repeating decimals, rounded half-up at the fourth digit.
    ['100', 3, '33.3333'],
    ['100.00', 3, '33.3333'],
    ['200.00', 3, '66.6667'],
    ['10', 6, '1.6667'],
    ['0.01', 3, '0.0033'],
    ['0.02', 3, '0.0067'],
    ['145.68', 3, '48.56'],
    ['139.97', 3, '46.6567'],
    // Exactly half rounds up.
    ['0.0001', 2, '0.0001'],
    ['0.0003', 2, '0.0002'],
    ['1.00', 32, '0.0313'],
    // A carry out of the fraction.
    ['29.99995', 3, '10.0000'],
    ['19.9999', 2, '10.0000'],
    // More than four digits in: rounded once, not twice (0.0000496... is not 0.0001).
    ['0.000149', 3, '0.0000'],
    ['0.123456', 1, '0.1235'],
    ['12345678901234567890.12', 2, '6172839450617283945.06'],
  ])('%s / %i = %s', (value, divisor, quotient) => {
    expect(divideDecimal(value, divisor)).toBe(quotient)
  })

  it('rounds to the fraction digits asked for', () => {
    expect(divideDecimal('100', 3, 2)).toBe('33.33')
    expect(divideDecimal('200', 3, 0)).toBe('67')
    expect(divideDecimal('1', 3, 8)).toBe('0.33333333')
    expect(divideDecimal('2.5', 1, 0)).toBe('3')
  })

  it('is null for a divisor that is not a positive whole number, or a value that is not a decimal', () => {
    expect(divideDecimal('10.00', 0)).toBeNull()
    expect(divideDecimal('10.00', -2)).toBeNull()
    expect(divideDecimal('10.00', 1.5)).toBeNull()
    expect(divideDecimal('10.00', Number.NaN)).toBeNull()
    expect(divideDecimal('10.00', Number.POSITIVE_INFINITY)).toBeNull()
    expect(divideDecimal('-10.00', 2)).toBeNull()
    expect(divideDecimal('ten', 2)).toBeNull()
    expect(divideDecimal('10.00', 2, -1)).toBeNull()
  })
})

describe('toMoneyAmount', () => {
  it.each([
    ['426.96', '426.96'],
    ['0.00', '0.00'],
    ['0', '0'],
    ['5', '5'],
    ['12.3', '12.3'],
    ['0.1234', '0.1234'],
    // Half-up at the fifth digit.
    ['0.12345', '0.1235'],
    ['12.345678', '12.3457'],
    ['1.23454', '1.2345'],
    ['1.23455', '1.2346'],
    ['0.00005', '0.0001'],
    ['0.00004', '0.0000'],
    ['9.99995', '10.0000'],
    // Already short enough: unchanged, zeros included.
    ['49.9900', '49.9900'],
    ['007.50', '7.50'],
    ['000', '0'],
    ['999999999999999.9999', '999999999999999.9999'],
  ])('%s → %s', (value, amount) => {
    expect(toMoneyAmount(value)).toBe(amount)
    expect(moneySchema.safeParse({ amount: toMoneyAmount(value), currency: 'PLN' }).success).toBe(true)
  })

  it('is null for an amount with more than 15 integer digits, also when rounding makes it so', () => {
    expect(toMoneyAmount('1000000000000000')).toBeNull()
    expect(toMoneyAmount('1000000000000000.00')).toBeNull()
    expect(toMoneyAmount('999999999999999.99995')).toBeNull()
  })

  it('is null for a negative amount and for anything that is not a number', () => {
    expect(toMoneyAmount('-73.99')).toBeNull()
    expect(toMoneyAmount('')).toBeNull()
    expect(toMoneyAmount('12,50')).toBeNull()
    expect(toMoneyAmount('1e2')).toBeNull()
  })
})
