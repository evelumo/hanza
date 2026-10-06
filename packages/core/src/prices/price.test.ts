import { describe, expect, it } from 'vitest'
import { DomainError } from '../errors'
import { decidePricePush, effectivePrice, moneyFromColumns, parsePrice, priceStatus, sameMoney } from './price'

const pln = (amount: string) => ({ amount, currency: 'PLN' })
const eur = (amount: string) => ({ amount, currency: 'EUR' })

describe('parsePrice', () => {
  it.each([
    ['10.50', '10.5'],
    ['0010', '10'],
    ['0.01', '0.01'],
    ['999999999999999.99', '999999999999999.99'],
  ])('keeps %s as %s', (amount, expected) => {
    expect(parsePrice(pln(amount))).toEqual(pln(expected))
  })

  const invalid = (input: { amount: string; currency: string }) => {
    let error: unknown
    try {
      parsePrice(input)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(DomainError)
    expect((error as DomainError).code).toBe('invalid_price')
  }

  it.each(['0', '0.0000', '-1', '1.00001', '1,5', '', '1e3'])('rejects the amount %j', (amount) => {
    invalid(pln(amount))
  })

  it('rejects a currency that is not three uppercase letters', () => {
    invalid({ amount: '1', currency: 'pln' })
  })

  it('refuses more decimal places than the currency has, instead of rounding', () => {
    invalid(pln('1.005'))
    invalid({ amount: '45.5', currency: 'JPY' })
    expect(parsePrice({ amount: '45.0', currency: 'JPY' })).toEqual({ amount: '45', currency: 'JPY' })
    expect(parsePrice({ amount: '1.234', currency: 'KWD' })).toEqual({ amount: '1.234', currency: 'KWD' })
    invalid({ amount: '1.2345', currency: 'KWD' })
  })
})

describe('moneyFromColumns and sameMoney', () => {
  it('needs both columns', () => {
    expect(moneyFromColumns({ toFixed: () => '1.5' }, 'PLN')).toEqual(pln('1.5'))
    expect(moneyFromColumns(null, 'PLN')).toBeNull()
    expect(moneyFromColumns({ toFixed: () => '1.5' }, null)).toBeNull()
  })

  it('compares amounts as decimals and currencies exactly', () => {
    expect(sameMoney(pln('10.50'), pln('10.5'))).toBe(true)
    expect(sameMoney(pln('10.5'), eur('10.5'))).toBe(false)
    expect(sameMoney(pln('10.5'), pln('10.51'))).toBe(false)
    expect(sameMoney(null, null)).toBe(true)
    expect(sameMoney(pln('1'), null)).toBe(false)
  })
})

describe('effectivePrice', () => {
  it('is the override, else the base price, else null', () => {
    expect(effectivePrice(pln('5'), pln('10'))).toEqual(pln('5'))
    expect(effectivePrice(null, pln('10'))).toEqual(pln('10'))
    expect(effectivePrice(null, null)).toBeNull()
  })
})

describe('decidePricePush', () => {
  it('pushes only a price in the currency the Channel reported', () => {
    expect(decidePricePush(pln('10'), 'PLN')).toEqual({ push: pln('10') })
    expect(decidePricePush(pln('10'), 'EUR')).toEqual({ skip: 'currency_mismatch' })
    expect(decidePricePush(pln('10'), null)).toEqual({ skip: 'currency_unknown' })
    expect(decidePricePush(null, 'PLN')).toEqual({ skip: 'no_price' })
  })
})

describe('priceStatus', () => {
  const offer = {
    linked: true,
    supported: true,
    effective: pln('10'),
    channelCurrency: 'PLN',
    lastPushed: pln('10.00'),
    awaitingPush: false,
  }

  it('is pushed when the last pushed price equals the effective one and nothing is waiting', () => {
    expect(priceStatus(offer)).toBe('pushed')
  })

  it('is pending while a push is due or the last pushed price differs', () => {
    expect(priceStatus({ ...offer, awaitingPush: true })).toBe('pending')
    expect(priceStatus({ ...offer, lastPushed: pln('9') })).toBe('pending')
    expect(priceStatus({ ...offer, lastPushed: null })).toBe('pending')
  })

  it('names why nothing is pushed', () => {
    expect(priceStatus({ ...offer, linked: false })).toBe('not_linked')
    expect(priceStatus({ ...offer, supported: false })).toBe('unsupported')
    expect(priceStatus({ ...offer, effective: null })).toBe('no_price')
    expect(priceStatus({ ...offer, channelCurrency: null })).toBe('currency_unknown')
    expect(priceStatus({ ...offer, channelCurrency: 'EUR' })).toBe('currency_mismatch')
  })
})
