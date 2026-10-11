import { PermanentError } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { variantSchema } from '../api'
import { raw, rawVariant } from '../testing/samples'
import { isPlainPrice, mapOffer, offerName, offerPrice } from './offer'

const variant = (overrides: Record<string, unknown> = {}) => variantSchema.parse(rawVariant('variant_01A', overrides))

describe('mapOffer', () => {
  it('maps a variant of a published product as an active Offer with its plain price', () => {
    expect(mapOffer(variant({ sku: ' MUG-1 ' }), 'PLN')).toEqual({
      externalId: 'variant_01A',
      sku: 'MUG-1',
      name: 'Mug',
      url: null,
      price: { amount: '49.99', currency: 'PLN' },
      status: 'active',
    })
  })

  it.each([['draft'], ['proposed'], ['rejected'], [null]])('reports a product in status %s as inactive, never ended', (status) => {
    expect(mapOffer(variant({ product: { title: 'Mug', status } }), 'PLN').status).toBe('inactive')
  })

  it('reports an empty SKU as none', () => {
    expect(mapOffer(variant({ sku: '' }), 'PLN').sku).toBeNull()
    expect(mapOffer(variant({ sku: null }), 'PLN').sku).toBeNull()
  })
})

describe('offerName', () => {
  it.each([
    [{ title: 'S', product: { title: 'T-shirt' } }, 'T-shirt - S'],
    [{ title: 'Default variant', product: { title: 'Mug' } }, 'Mug'],
    [{ title: 'default variant', product: { title: 'Mug' } }, 'Mug'],
    [{ title: '', product: { title: 'Mug' } }, 'Mug'],
    [{ title: 'Blue', product: { title: '' } }, 'Blue'],
    [{ title: 'Blue', product: null }, 'Blue'],
    [{ title: null, product: null }, '#variant_01A'],
  ])('names %j %j', (fields, expected) => {
    expect(offerName({ id: 'variant_01A', ...(fields as object) } as never)).toBe(expected)
  })
})

describe('offerPrice', () => {
  const price = (overrides: Record<string, unknown>) => ({ currency_code: 'pln', amount: 49.99, min_quantity: null, max_quantity: null, ...overrides })

  it('takes the raw amount when Medusa sends it, else the number written out exactly', () => {
    expect(offerPrice(variant({ prices: [price({ amount: 12.3, raw_amount: raw('12.30') })] }), 'PLN')).toEqual({ amount: '12.30', currency: 'PLN' })
    expect(offerPrice(variant({ prices: [price({ amount: 0.1 + 0.2 })] }), 'PLN')).toEqual({ amount: '0.3000', currency: 'PLN' })
    expect(offerPrice(variant({ prices: [price({ amount: 1999 })] }), 'PLN')).toEqual({ amount: '1999', currency: 'PLN' })
  })

  it('takes the plain price in the currency, never a price tied to a region, a group, a price list or a quantity', () => {
    const prices = [
      price({ amount: 10, rules: { region_id: 'reg_1' } }),
      price({ amount: 11, rules_count: 1 }),
      price({ amount: 12, price_rules: [{ attribute: 'customer_group_id' }] }),
      price({ amount: 13, price_list_id: 'plist_1' }),
      price({ amount: 14, min_quantity: 10 }),
      price({ currency_code: 'eur', amount: 15 }),
      price({ amount: 16, rules: {}, min_quantity: 1 }),
    ]
    expect(offerPrice(variant({ prices }), 'PLN')).toEqual({ amount: '16', currency: 'PLN' })
    expect(offerPrice(variant({ prices }), 'EUR')).toEqual({ amount: '15', currency: 'EUR' })
  })

  it('is null without a currency, without a plain price in it, or when the amount does not fit Money', () => {
    expect(offerPrice(variant(), null)).toBeNull()
    expect(offerPrice(variant(), 'USD')).toBeNull()
    expect(offerPrice(variant({ prices: [] }), 'PLN')).toBeNull()
    expect(offerPrice(variant({ prices: [price({ amount: -1 })] }), 'PLN')).toBeNull()
    expect(offerPrice(variant({ prices: [price({ amount: 1e16 })] }), 'PLN')).toBeNull()
    expect(offerPrice(variant({ prices: [price({ raw_amount: raw('abc') })] }), 'PLN')).toBeNull()
  })

  it('rounds a raw amount with more than 4 places half-up', () => {
    expect(offerPrice(variant({ prices: [price({ raw_amount: raw('1.23455') })] }), 'PLN')).toEqual({ amount: '1.2346', currency: 'PLN' })
  })

  it('reads the empty rule shapes as plain', () => {
    expect(isPlainPrice(price({ rules: [], rules_count: 0, price_rules: [], price_list_id: null }) as never)).toBe(true)
  })
})

describe('an Offer that cannot be valid', () => {
  it('fails the page with a PermanentError naming the variant', () => {
    expect(() => mapOffer(variantSchema.parse({ id: 'variant_x', title: 'T', product: { title: 'P', status: 'published' } }), 'PLN')).not.toThrow()
    expect(() => mapOffer({ id: '', title: 'T' } as never, 'PLN')).toThrow(PermanentError)
  })
})
