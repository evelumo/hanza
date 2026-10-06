import { describe, expect, it } from 'vitest'
import {
  createProductSchema,
  createProductsFromOffersSchema,
  linkOfferSchema,
  priceFromForm,
  setBasePriceSchema,
  setOfferPriceSchema,
  setStockSchema,
} from './schemas'

describe('createProductSchema', () => {
  it('trims the SKU and name and reads the stock as a number', () => {
    expect(createProductSchema.parse({ sku: '  ABC-1 ', name: ' Mug ', stock: '12' })).toEqual({ sku: 'ABC-1', name: 'Mug', stock: 12 })
  })

  it('rejects an empty or too long SKU and name', () => {
    expect(createProductSchema.safeParse({ sku: '   ', name: 'x', stock: '0' }).success).toBe(false)
    expect(createProductSchema.safeParse({ sku: 'a'.repeat(65), name: 'x', stock: '0' }).success).toBe(false)
    expect(createProductSchema.safeParse({ sku: 'a', name: '', stock: '0' }).success).toBe(false)
    expect(createProductSchema.safeParse({ sku: 'a', name: 'x'.repeat(201), stock: '0' }).success).toBe(false)
    expect(createProductSchema.safeParse({ sku: 'a'.repeat(64), name: 'x'.repeat(200), stock: '0' }).success).toBe(true)
  })
})

describe('stock input', () => {
  it.each(['', ' ', '-1', '1.5', '1e3', 'abc', '1000001', '99999999'])('rejects %j', (stock) => {
    expect(setStockSchema.safeParse({ productId: 'p', stock }).success).toBe(false)
  })

  it.each([['0', 0], ['1000000', 1_000_000], [' 7 ', 7]] as const)('accepts %j', (stock, expected) => {
    expect(setStockSchema.parse({ productId: 'p', stock }).stock).toBe(expected)
  })

  it('needs a product id', () => {
    expect(setStockSchema.safeParse({ productId: '', stock: '1' }).success).toBe(false)
  })
})

describe('linkOfferSchema', () => {
  it('requires a SKU and trims it', () => {
    expect(linkOfferSchema.parse({ offerId: 'o', sku: ' X ' }).sku).toBe('X')
    expect(linkOfferSchema.safeParse({ offerId: 'o', sku: '' }).success).toBe(false)
  })
})

describe('createProductsFromOffersSchema', () => {
  it('needs between 1 and 200 offers', () => {
    expect(createProductsFromOffersSchema.safeParse({ offerIds: [] }).success).toBe(false)
    expect(createProductsFromOffersSchema.safeParse({ offerIds: Array.from({ length: 200 }, (_, i) => String(i + 1)) }).success).toBe(true)
    expect(createProductsFromOffersSchema.safeParse({ offerIds: Array.from({ length: 201 }, (_, i) => String(i + 1)) }).success).toBe(false)
  })
})

describe('price forms', () => {
  it('read a comma as the decimal separator, keep the amount a string and upper-case the currency', () => {
    expect(setBasePriceSchema.parse({ productId: 'p', intent: 'set', amount: ' 49,90 ', currency: ' pln ' })).toEqual({
      productId: 'p',
      intent: 'set',
      amount: '49.90',
      currency: 'PLN',
    })
    expect(setOfferPriceSchema.parse({ offerId: 'o', intent: 'set', amount: '1.234', currency: 'kwd' })).toMatchObject({ amount: '1.234', currency: 'KWD' })
  })

  it.each([
    ['', 'validation.priceInvalid'],
    ['0', 'validation.priceInvalid'],
    ['-1', 'validation.priceInvalid'],
    ['1e3', 'validation.priceInvalid'],
    ['1000000000000000', 'validation.priceInvalid'],
    ['1,234', 'validation.priceAmbiguous'],
    ['1.234', 'validation.priceAmbiguous'],
    ['1.23456', 'validation.priceTooManyDecimals'],
  ])('reject the amount %j in PLN on the amount field', (amount, message) => {
    const result = setBasePriceSchema.safeParse({ productId: 'p', intent: 'set', amount, currency: 'PLN' })
    expect(result.error?.issues.map((issue) => [issue.path.join('.'), issue.message])).toEqual([['amount', message]])
  })

  it('read the amount for its currency', () => {
    const parse = (amount: string, currency: string) => setOfferPriceSchema.safeParse({ offerId: 'o', intent: 'set', amount, currency })
    expect(parse('45.5', 'JPY').success).toBe(false)
    expect(parse('45', 'JPY').data).toMatchObject({ amount: '45', currency: 'JPY' })
    expect(parse('1 234,50', 'PLN').data).toMatchObject({ amount: '1234.50' })
    expect(parse('1,234.50', 'PLN').data).toMatchObject({ amount: '1234.50' })
  })

  it.each(['', 'PL', 'PLNN', 'zł', '123'])('reject the currency %j', (currency) => {
    expect(setOfferPriceSchema.safeParse({ offerId: 'o', intent: 'set', amount: '1', currency }).success).toBe(false)
  })

  it('remove the price with intent clear, whatever the fields hold', () => {
    const parsed = setBasePriceSchema.parse({ productId: 'p', intent: 'clear', amount: 'not a price', currency: '' })
    expect(priceFromForm(parsed)).toBeNull()
    expect(priceFromForm(setOfferPriceSchema.parse({ offerId: 'o', intent: 'set', amount: '5', currency: 'eur' }))).toEqual({
      amount: '5',
      currency: 'EUR',
    })
  })

  it('need an id and a known intent', () => {
    expect(setBasePriceSchema.safeParse({ productId: '', intent: 'clear' }).success).toBe(false)
    expect(setOfferPriceSchema.safeParse({ offerId: 'o', intent: 'drop' }).success).toBe(false)
    expect(setOfferPriceSchema.safeParse({ productId: 'p', intent: 'clear' }).success).toBe(false)
  })
})
