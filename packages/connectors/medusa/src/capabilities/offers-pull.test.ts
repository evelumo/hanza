import { PermanentError, TransientError, type Offer } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { PLUGIN_MISSING_MESSAGE } from '../client'
import { createMedusaConnector } from '../connector'
import { FakeMedusa } from '../testing/fake-medusa'
import { raw } from '../testing/samples'
import { decodeOffersCursor, encodeOffersCursor } from './offers-pull'

function pull(store: FakeMedusa, cursor: string | null, pageSize = 100) {
  return createMedusaConnector({ pageSize }).capabilities['offers.pull']!(store.context(), cursor)
}

async function pullAll(store: FakeMedusa, pageSize: number, between: (page: number) => void = () => {}) {
  const offers: Offer[] = []
  let cursor: string | null = null
  for (let page = 1; page < 50; page++) {
    const result = await pull(store, cursor, pageSize)
    offers.push(...result.items)
    if (!result.hasMore) return offers
    cursor = result.nextCursor
    between(page)
  }
  throw new Error('the pull did not end')
}

function storeWith(count: number): FakeMedusa {
  const store = new FakeMedusa()
  for (let index = 1; index <= count; index++) store.variant(`variant_${String(index).padStart(3, '0')}`)
  return store
}

describe('offers.pull', () => {
  it('reads the currency once, then pages variants by id with a page of overlap', async () => {
    const store = storeWith(5)
    const offers = await pullAll(store, 2)
    expect(offers.map((offer) => offer.externalId)).toEqual(['variant_001', 'variant_002', 'variant_003', 'variant_004', 'variant_005'])
    expect(store.urls).toEqual([
      'GET hanza/status',
      'GET product-variants?order=id&offset=0&limit=2&fields=id,sku,title,manage_inventory,product_id,product.title,product.status,*prices,prices.price_rules.attribute,prices.price_rules.value',
      'GET product-variants?order=id&offset=0&limit=4&fields=id,sku,title,manage_inventory,product_id,product.title,product.status,*prices,prices.price_rules.attribute,prices.price_rules.value',
      'GET product-variants?order=id&offset=2&limit=4&fields=id,sku,title,manage_inventory,product_id,product.title,product.status,*prices,prices.price_rules.attribute,prices.price_rules.value',
    ])
  })

  it('loses no variant when one before the position is deleted between pages, and sends none twice', async () => {
    const store = storeWith(7)
    const offers = await pullAll(store, 2, (page) => {
      if (page === 1) store.deleteVariant('variant_001')
      if (page === 2) store.deleteVariant('variant_002').deleteVariant('variant_003')
    })
    expect(offers.map((offer) => offer.externalId)).toEqual(['variant_001', 'variant_002', 'variant_003', 'variant_004', 'variant_005', 'variant_006', 'variant_007'])
  })

  it('reads from the start when the step-backs reach it, losing nothing', async () => {
    const store = storeWith(6)
    const offers = await pullAll(store, 2, (page) => {
      if (page === 2) for (const id of ['variant_001', 'variant_002', 'variant_003', 'variant_004']) store.deleteVariant(id)
    })
    expect(offers.map((offer) => offer.externalId)).toEqual(Array.from({ length: 6 }, (_, index) => `variant_00${index + 1}`))
  })

  it('steps back further when more than a page of variants before the position was deleted', async () => {
    const store = storeWith(9)
    const offers = await pullAll(store, 2, (page) => {
      if (page === 2) for (const id of ['variant_001', 'variant_002', 'variant_003']) store.deleteVariant(id)
    })
    expect(offers.map((offer) => offer.externalId)).toEqual(Array.from({ length: 9 }, (_, index) => `variant_00${index + 1}`))
  })

  it('gives up with a TransientError when the list moved by more than its step-backs can reach', async () => {
    const store = storeWith(30)
    let cursor: string | null = null
    for (let page = 0; page < 6; page++) cursor = (await pull(store, cursor, 2)).nextCursor
    expect(decodeOffersCursor(cursor!)).toMatchObject({ lastId: 'variant_012' })
    for (let index = 1; index <= 10; index++) store.deleteVariant(`variant_${String(index).padStart(3, '0')}`)
    await expect(pull(store, cursor, 2)).rejects.toBeInstanceOf(TransientError)
  })

  it('reports prices in the plugin\'s currency, else the store\'s default, and none without either', async () => {
    const store = new FakeMedusa().variant('variant_001', {
      prices: [
        { currency_code: 'pln', amount: 49.99, raw_amount: raw('49.99'), min_quantity: null },
        { currency_code: 'eur', amount: 11.5, min_quantity: null },
      ],
    })
    expect((await pull(store, null)).items[0]!.price).toEqual({ amount: '49.99', currency: 'PLN' })
    store.settings.currency_code = 'eur'
    expect((await pull(store, null)).items[0]!.price).toEqual({ amount: '11.5', currency: 'EUR' })
    store.settings.currency_code = null
    store.defaultCurrency = null
    expect((await pull(store, null)).items[0]!.price).toBeNull()
  })

  it('carries the currency in the cursor, so a later page asks the plugin nothing', async () => {
    const store = storeWith(3)
    const first = await pull(store, null, 2)
    expect(decodeOffersCursor(first.nextCursor!)).toEqual({ currency: 'PLN', consumed: 2, lastId: 'variant_002' })
    store.requests.length = 0
    await pull(store, first.nextCursor, 2)
    expect(store.urls.every((url) => url.startsWith('GET product-variants'))).toBe(true)
  })

  it('ends with no Offers when nothing follows the position', async () => {
    const store = storeWith(2)
    const first = await pull(store, null, 2)
    expect(first.hasMore).toBe(true)
    expect(await pull(store, first.nextCursor, 2)).toEqual({ items: [], nextCursor: first.nextCursor, hasMore: false })
  })

  it('says the plugin is missing, and refuses a cursor it cannot read', async () => {
    const store = storeWith(1)
    store.pluginInstalled = false
    await expect(pull(store, null)).rejects.toThrow(PLUGIN_MISSING_MESSAGE)
    await expect(pull(store, 'v2:PLN:0:x')).rejects.toBeInstanceOf(PermanentError)
    await expect(pull(store, 'v1:pln:0:x')).rejects.toBeInstanceOf(PermanentError)
    await expect(pull(store, 'v1:PLN:0:')).rejects.toBeInstanceOf(PermanentError)
  })

  it('writes a cursor it reads back', () => {
    const cursor = { currency: null, consumed: 200, lastId: 'variant:odd' }
    expect(decodeOffersCursor(encodeOffersCursor(cursor))).toEqual(cursor)
  })
})
