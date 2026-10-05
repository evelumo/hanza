import { describe, expect, it } from 'vitest'
import {
  createProductSchema,
  createProductsFromOffersSchema,
  linkOfferSchema,
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
    expect(setStockSchema.safeParse({ productId: 'p', warehouseId: 'w', stock }).success).toBe(false)
  })

  it.each([['0', 0], ['1000000', 1_000_000], [' 7 ', 7]] as const)('accepts %j', (stock, expected) => {
    expect(setStockSchema.parse({ productId: 'p', warehouseId: 'w', stock }).stock).toBe(expected)
  })

  it('needs a product id', () => {
    expect(setStockSchema.safeParse({ productId: '', warehouseId: 'w', stock: '1' }).success).toBe(false)
  })

  it('needs a warehouse id', () => {
    expect(setStockSchema.safeParse({ productId: 'p', stock: '1' }).success).toBe(false)
    expect(setStockSchema.safeParse({ productId: 'p', warehouseId: '', stock: '1' }).success).toBe(false)
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
