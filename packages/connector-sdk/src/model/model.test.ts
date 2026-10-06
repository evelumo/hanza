import { describe, expect, it } from 'vitest'
import { offerSchema } from './offer'
import { currencyMinorUnits, moneySchema } from './money'
import { orderSchema } from './order'
import { offerPriceSchema } from './price'
import { stockLevelSchema } from './stock'

const address = {
  name: 'John Test',
  company: null,
  street: '1 Example Street',
  postalCode: '00-001',
  city: 'Warsaw',
  countryCode: 'PL',
  phone: null,
  taxId: null,
}

const order = {
  externalId: 'o-1',
  placedAt: '2026-10-01T09:00:00Z',
  payment: 'prepaid',
  total: { amount: '79.98', currency: 'PLN' },
  buyer: { name: 'John Test', email: null, phone: null, login: null },
  shippingAddress: address,
  billingAddress: null,
  lines: [
    {
      externalId: 'l1',
      offerExternalId: 'offer-1',
      sku: 'SKU-1',
      name: 'Mug',
      quantity: 2,
      unitPrice: { amount: '39.99', currency: 'PLN' },
    },
  ],
  facts: [{ id: 'o-1:cancelled', type: 'cancelled', occurredAt: '2026-10-02T10:00:00+02:00', note: null }],
}

describe('moneySchema', () => {
  it.each(['0', '129.99', '1.5', '999999999999999.9999'])('accepts "%s"', (amount) => {
    expect(moneySchema.safeParse({ amount, currency: 'PLN' }).success).toBe(true)
  })

  it.each([
    ['a number instead of a string', 129.99],
    ['5 fraction digits', '1.00001'],
    ['16 integer digits', '1000000000000000'],
    ['a negative amount', '-1.00'],
    ['a trailing dot', '1.'],
    ['an empty string', ''],
  ])('rejects %s', (_label, amount) => {
    expect(moneySchema.safeParse({ amount, currency: 'PLN' }).success).toBe(false)
  })

  it.each(['pln', 'PL', 'PLNN', ''])('rejects the currency "%s"', (currency) => {
    expect(moneySchema.safeParse({ amount: '1.00', currency }).success).toBe(false)
  })
})

describe('currencyMinorUnits', () => {
  it.each([
    ['PLN', 2],
    ['EUR', 2],
    ['HUF', 2],
    ['IDR', 2],
    ['JPY', 0],
    ['KRW', 0],
    ['VND', 0],
    ['CLP', 0],
    ['ISK', 0],
    ['UGX', 0],
    ['KWD', 3],
    ['BHD', 3],
    ['OMR', 3],
    ['JOD', 3],
    ['TND', 3],
    ['IQD', 3],
    ['CLF', 4],
    ['XYZ', 2],
    ['jpy', 2],
  ] as const)('%s has %i', (currency, units) => {
    expect(currencyMinorUnits(currency)).toBe(units)
  })

  it('does not depend on Intl', () => {
    const original = Intl.NumberFormat
    Intl.NumberFormat = (() => {
      throw new Error('Intl must not be used')
    }) as unknown as typeof Intl.NumberFormat
    try {
      expect(currencyMinorUnits('HUF')).toBe(2)
      expect(currencyMinorUnits('JPY')).toBe(0)
    } finally {
      Intl.NumberFormat = original
    }
  })
})

describe('orderSchema', () => {
  it('accepts a complete Order', () => {
    expect(orderSchema.parse(order)).toEqual(order)
  })

  it('requires an offset in datetimes', () => {
    expect(orderSchema.safeParse({ ...order, placedAt: '2026-10-01T09:00:00' }).success).toBe(false)
    const fact = { ...order.facts[0], occurredAt: '2026-10-02T10:00:00' }
    expect(orderSchema.safeParse({ ...order, facts: [fact] }).success).toBe(false)
  })

  it('rejects an Order without lines, a status field is not part of the model', () => {
    expect(orderSchema.safeParse({ ...order, lines: [] }).success).toBe(false)
    expect('status' in orderSchema.shape).toBe(false)
  })

  it('rejects an unknown fact type and a non-integer quantity', () => {
    expect(orderSchema.safeParse({ ...order, facts: [{ ...order.facts[0], type: 'refunded' }] }).success).toBe(false)
    const line = { ...order.lines[0], quantity: 1.5 }
    expect(orderSchema.safeParse({ ...order, lines: [line] }).success).toBe(false)
  })

  it('accepts an Order awaiting payment; leaving the flag out keeps older connectors valid', () => {
    expect(orderSchema.parse({ ...order, awaitingPayment: true })).toEqual({ ...order, awaitingPayment: true })
    expect('awaitingPayment' in orderSchema.parse(order)).toBe(false)
    const paidFact = { id: 'o-1:paid', type: 'paid', occurredAt: '2026-10-02T10:00:00Z', note: null }
    expect(orderSchema.safeParse({ ...order, awaitingPayment: false, facts: [paidFact] }).success).toBe(true)
  })

  it('rejects an Order awaiting payment that is cash on delivery or already has a paid fact', () => {
    const cod = orderSchema.safeParse({ ...order, payment: 'cash_on_delivery', awaitingPayment: true })
    expect(cod.success).toBe(false)
    expect(cod.error?.issues[0]?.path).toEqual(['awaitingPayment'])
    const paidFact = { id: 'o-1:paid', type: 'paid', occurredAt: '2026-10-02T10:00:00Z', note: null }
    expect(orderSchema.safeParse({ ...order, awaitingPayment: true, facts: [paidFact] }).success).toBe(false)
  })

  it('rejects a lowercase country code', () => {
    expect(orderSchema.safeParse({ ...order, shippingAddress: { ...address, countryCode: 'pl' } }).success).toBe(false)
  })
})

describe('offerSchema and stockLevelSchema', () => {
  it('accepts an Offer without SKU or url', () => {
    expect(offerSchema.safeParse({ externalId: 'a', sku: null, name: 'Stickers', url: null }).success).toBe(true)
  })

  it('accepts an Offer with, without or with a null Channel price, and rejects a float price', () => {
    const offer = { externalId: 'a', sku: null, name: 'Stickers', url: null }
    expect(offerSchema.safeParse({ ...offer, price: { amount: '12.50', currency: 'EUR' } }).success).toBe(true)
    expect(offerSchema.safeParse({ ...offer, price: null }).success).toBe(true)
    expect(offerSchema.safeParse({ ...offer, price: { amount: 12.5, currency: 'EUR' } }).success).toBe(false)
  })

  it('rejects an Offer with a malformed url', () => {
    expect(offerSchema.safeParse({ externalId: 'a', sku: null, name: 'x', url: 'not a url' }).success).toBe(false)
  })

  it('requires a price on an OfferPrice', () => {
    expect(offerPriceSchema.safeParse({ offerExternalId: 'a', sku: null, price: { amount: '9.99', currency: 'PLN' } }).success).toBe(true)
    expect(offerPriceSchema.safeParse({ offerExternalId: 'a', sku: null, price: null }).success).toBe(false)
    expect(offerPriceSchema.safeParse({ offerExternalId: '', sku: null, price: { amount: '9.99', currency: 'PLN' } }).success).toBe(false)
  })

  it('rejects negative and fractional availability', () => {
    expect(stockLevelSchema.safeParse({ offerExternalId: 'a', sku: null, available: 0 }).success).toBe(true)
    expect(stockLevelSchema.safeParse({ offerExternalId: 'a', sku: null, available: -1 }).success).toBe(false)
    expect(stockLevelSchema.safeParse({ offerExternalId: 'a', sku: null, available: 1.5 }).success).toBe(false)
  })
})
