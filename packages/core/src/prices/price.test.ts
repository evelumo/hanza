import { describe, expect, it } from 'vitest'
import { decidePricePush, effectivePrice, moneyFromColumns, parsePrice, priceStatus, sameMoney } from './price'

const pln = (amount: string) => ({ amount, currency: 'PLN' })
const eur = (amount: string) => ({ amount, currency: 'EUR' })

describe('parsePrice', () => {
  it.each([
    ['10.50', '10.5'],
    ['0010', '10'],
    ['0.0001', '0.0001'],
    ['999999999999999.9999', '999999999999999.9999'],
  ])('keeps %s as %s', (amount, expected) => {
    expect(parsePrice(pln(amount))).toEqual(pln(expected))
  })

  it.each(['0', '0.0000', '-1', '1.00001', '1,5', '', '1e3'])('rejects the amount %j', (amount) => {
    expect(() => parsePrice(pln(amount))).toThrow(RangeError)
  })

  it('rejects a currency that is not three uppercase letters', () => {
    expect(() => parsePrice({ amount: '1', currency: 'pln' })).toThrow(RangeError)
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
