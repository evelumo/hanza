import { offerSchema } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { wooProductSchema, wooVariationSchema } from '../api'
import { rawSimpleProduct, rawVariableProduct, rawVariation } from '../testing/samples'
import { lineOfferId, mapProductOffer, mapVariationOffer, parseOfferId, productKind, productOfferId, variationOfferId } from './offer'

const product = (overrides: Record<string, unknown> = {}) => wooProductSchema.parse(rawSimpleProduct(overrides))
const parent = (overrides: Record<string, unknown> = {}) => wooProductSchema.parse(rawVariableProduct(overrides))
const variation = (overrides: Record<string, unknown> = {}) => wooVariationSchema.parse(rawVariation(overrides))

describe('Offer ids', () => {
  it('a simple product is its id, a variation its parent and its own', () => {
    expect(productOfferId(10)).toBe('10')
    expect(variationOfferId(19, 21)).toBe('19:21')
  })

  it('reads back what it wrote', () => {
    expect(parseOfferId(productOfferId(10))).toEqual({ kind: 'product', productId: 10 })
    expect(parseOfferId(variationOfferId(19, 21))).toEqual({ kind: 'variation', parentId: 19, variationId: 21 })
  })

  it.each(['', '0', '010', '-5', '1.5', '10:', ':21', '19:0', '0:21', '19:21:3', '19-21', ' 10', '10 ', 'abc', '19:x', '99999999999999999999', '19:99999999999999999999'])(
    'refuses %j',
    (externalId) => {
      expect(parseOfferId(externalId)).toBeNull()
    },
  )

  it('names the Offer of an order line from the two ids the line carries', () => {
    expect(lineOfferId(10, 0)).toBe('10')
    expect(lineOfferId(19, 21)).toBe('19:21')
    // A deleted product: WooCommerce sends product_id 0.
    expect(lineOfferId(0, 0)).toBeNull()
    expect(lineOfferId(0, 21)).toBeNull()
  })

  it('agrees with itself: a line of a variation points at the Offer of that variation', () => {
    expect(lineOfferId(19, 21)).toBe(mapVariationOffer(parent(), variation(), 'PLN').externalId)
    expect(lineOfferId(10, 0)).toBe(mapProductOffer(product(), 'PLN').externalId)
  })
})

describe('productKind', () => {
  it.each([
    ['simple', 'simple'],
    ['variable', 'variable'],
    ['grouped', 'other'],
    ['external', 'other'],
    ['subscription', 'other'],
    ['bundle', 'other'],
    ['variation', 'other'],
  ] as const)('%s → %s', (type, kind) => {
    expect(productKind({ type })).toBe(kind)
  })
})

describe('mapProductOffer', () => {
  it('maps a simple product', () => {
    const offer = mapProductOffer(product(), 'PLN')
    expect(offer).toEqual({
      externalId: '10',
      sku: 'WOO-MUG-1',
      name: 'Kubek ceramiczny żółty',
      url: 'https://shop.example.test/product/kubek-ceramiczny-zolty/',
      price: { amount: '49.99', currency: 'PLN' },
      status: 'active',
    })
    expect(offerSchema.parse(offer)).toEqual(offer)
  })

  it('has no SKU for a product without one', () => {
    expect(mapProductOffer(product({ sku: '' }), 'PLN').sku).toBeNull()
    expect(mapProductOffer(product({ sku: '  ' }), 'PLN').sku).toBeNull()
  })

  it.each([
    ['publish', 'active'],
    ['draft', 'inactive'],
    ['pending', 'inactive'],
    ['private', 'inactive'],
    ['future', 'inactive'],
    ['a-plugins-status', 'inactive'],
  ])('status %s is %s, never ended', (status, publication) => {
    const offer = mapProductOffer(product({ status }), 'PLN')
    expect(offer.status).toBe(publication)
    expect(offer).not.toHaveProperty('endedReason')
  })

  it('stays active at stock 0: WooCommerce keeps the product published', () => {
    expect(mapProductOffer(product({ stock_quantity: 0, stock_status: 'outofstock' }), 'PLN').status).toBe('active')
  })

  it('reports the price a Buyer pays now, which is the sale price while on sale', () => {
    expect(mapProductOffer(product({ price: '99.00', regular_price: '129.00', sale_price: '99.00' }), 'PLN').price).toEqual({ amount: '99.00', currency: 'PLN' })
  })

  it.each([
    ['no price is set', '', 'PLN'],
    ['the key may not read the currency', '49.99', null],
    ['the price is not a number', 'od 49,99 zł', 'PLN'],
    ['the price is negative', '-1.00', 'PLN'],
    ['the price is too large for Money', '1000000000000000.00', 'PLN'],
    ['the currency is not an ISO code', '49.99', 'zł'],
  ])('has no price when %s', (_, price, currency) => {
    expect(mapProductOffer(product({ price }), currency).price).toBeNull()
  })

  it('rounds a price with more decimals than Money holds', () => {
    expect(mapProductOffer(product({ price: '0.123456' }), 'PLN').price).toEqual({ amount: '0.1235', currency: 'PLN' })
  })

  it('keeps the link of a draft, which has no pretty address yet', () => {
    expect(mapProductOffer(product({ status: 'draft', permalink: 'https://shop.example.test/?post_type=product&p=14' }), 'PLN').url).toBe(
      'https://shop.example.test/?post_type=product&p=14',
    )
  })

  it('has no link when the permalink is not a URL, and a name when the product has no title', () => {
    const offer = mapProductOffer(product({ permalink: '', name: '' }), 'PLN')
    expect(offer.url).toBeNull()
    expect(offer.name).toBe('#10')
  })
})

describe('mapVariationOffer', () => {
  it('maps a variation that has no SKU of its own: the parent\'s SKU it reports is not its own', () => {
    // The sandbox reports sku "WOO-TSHIRT" for variation 21, which is the SKU of product 19.
    expect(rawVariation().sku).toBe(rawVariableProduct().sku)
    const offer = mapVariationOffer(parent(), variation(), 'PLN')
    expect(offer).toEqual({
      externalId: '19:21',
      sku: null,
      name: 'Koszulka testowa - M',
      url: 'https://shop.example.test/product/koszulka-testowa/?attribute_rozmiar=M',
      price: { amount: '79.00', currency: 'PLN' },
      status: 'active',
    })
    expect(offerSchema.parse(offer)).toEqual(offer)
  })

  it('keeps a SKU of its own', () => {
    expect(mapVariationOffer(parent(), variation({ id: 20, sku: 'WOO-TSHIRT-S' }), 'PLN')).toMatchObject({ externalId: '19:20', sku: 'WOO-TSHIRT-S' })
  })

  it('has no SKU when neither it nor its parent has one', () => {
    expect(mapVariationOffer(parent({ sku: '' }), variation({ sku: '' }), 'PLN').sku).toBeNull()
  })

  it('is named like the order line WooCommerce writes for it', () => {
    const two = variation({ attributes: [{ id: 0, name: 'Kolor', slug: 'kolor', option: 'Czarny' }, { id: 0, name: 'Rozmiar', slug: 'rozmiar', option: 'M' }] })
    expect(mapVariationOffer(parent({ name: 'Bluza testowa' }), two, 'PLN').name).toBe('Bluza testowa - Czarny, M')
  })

  it('tells a variation that fixes no attribute apart by its id', () => {
    expect(mapVariationOffer(parent(), variation({ attributes: [] }), 'PLN').name).toBe('Koszulka testowa - #21')
  })

  it.each([
    ['publish', 'publish', 'active'],
    // "Enabled" unticked in the admin.
    ['publish', 'private', 'inactive'],
    ['draft', 'publish', 'inactive'],
    ['private', 'private', 'inactive'],
  ])('parent %s, variation %s → %s', (parentStatus, status, publication) => {
    expect(mapVariationOffer(parent({ status: parentStatus }), variation({ status }), 'PLN').status).toBe(publication)
  })

  it('has no price without a currency or a price, like a simple product', () => {
    expect(mapVariationOffer(parent(), variation(), null).price).toBeNull()
    expect(mapVariationOffer(parent(), variation({ price: '' }), 'PLN').price).toBeNull()
  })
})
