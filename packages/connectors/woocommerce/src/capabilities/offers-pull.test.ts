import { offerSchema, type Offer, type PullResult } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { WOO_PRODUCT_FIELDS, WOO_VARIATION_FIELDS } from '../api'
import { createWooCommerceConnector } from '../connector'
import type { WooCommerceContext } from '../settings'
import { withScenario } from '../testing/offer-scenario'
import { replayConfig, replayCredentials } from '../testing/recording'
import { rawSimpleProduct, rawVariableProduct, rawVariation } from '../testing/samples'
import { formatOffersCursor, MAX_VARIATION_REQUESTS, parseOffersCursor, pullOffers } from './offers-pull'

// The scenarios below replay cassettes recorded from the sandbox shop (sandbox/README.md). To record them again:
//
//   WOO_SANDBOX_PROJECT=<name> WOO_SANDBOX_PORT=<port> sandbox/sandbox.sh reset
//   WOO_SANDBOX_PROJECT=<name> WOO_SANDBOX_PORT=<port> HANZA_RECORD_FIXTURES=1 \
//     pnpm --filter @hanza/connector-woocommerce exec vitest run src/capabilities/offers-pull.test.ts
//
// One test file at a time: a scenario that needs the shop in another state puts it there itself, and back, which
// would change the shop under a recording running next to it.

interface Pulled extends PullResult<Offer> {
  cursor: string | null
}

/** Every page from `null` to the end, checking what the contract says about a cursor on the way. */
async function pullAll(pull: (cursor: string | null) => Promise<PullResult<Offer>>, from: string | null = null, maxCalls = 500): Promise<Pulled[]> {
  const pages: Pulled[] = []
  let cursor = from
  for (let call = 0; call < maxCalls; call++) {
    const page = await pull(cursor)
    pages.push({ cursor, ...page })
    if (!page.hasMore) return pages
    expect(page.nextCursor).not.toBeNull()
    expect(page.nextCursor).not.toBe(cursor)
    cursor = page.nextCursor
  }
  throw new Error(`offers.pull still has more after ${maxCalls} calls`)
}

const offersOf = (pages: Pulled[]) => pages.flatMap((page) => page.items)
const idsOf = (pages: Pulled[]) => offersOf(pages).map((offer) => offer.externalId)

const PRODUCTS = `&orderby=id&order=asc&_fields=${WOO_PRODUCT_FIELDS.join(',')}`
const VARIATIONS = `&orderby=id&order=asc&_fields=${WOO_VARIATION_FIELDS.join(',')}`
const PLN = (amount: string) => ({ amount, currency: 'PLN' })
const shopUrl = (path: string) => `https://shop.example.test/${path}`

// The seed of the sandbox (sandbox/php/seed.php) as Offers: the variable products 19 and 24 are not Offers, their
// variations are; the grouped product 27 and the external one 28 are left out.
const SEED_OFFERS: Offer[] = [
  { externalId: '10', sku: 'WOO-MUG-1', name: 'Kubek ceramiczny żółty', url: shopUrl('product/kubek-ceramiczny-zolty/'), price: PLN('49.99'), status: 'active' },
  { externalId: '11', sku: 'WOO-NOTE-1', name: 'Notes w kratkę A5', url: shopUrl('product/notes-w-kratke-a5/'), price: PLN('19.90'), status: 'active' },
  // No SKU.
  { externalId: '12', sku: null, name: 'Plakat bez SKU', url: shopUrl('product/plakat-bez-sku/'), price: PLN('35.00'), status: 'active' },
  { externalId: '13', sku: 'WOO-CANDLE-1', name: 'Świeca sojowa', url: shopUrl('product/swieca-sojowa/'), price: PLN('59.00'), status: 'active' },
  // A draft.
  { externalId: '14', sku: 'WOO-DRAFT-1', name: 'Szkic produktu', url: shopUrl('?post_type=product&p=14'), price: PLN('10.00'), status: 'inactive' },
  // No price.
  { externalId: '15', sku: 'WOO-NOPRICE-1', name: 'Produkt bez ceny', url: shopUrl('product/produkt-bez-ceny/'), price: null, status: 'active' },
  // On sale: the price a Buyer pays now, not the regular 129.00.
  { externalId: '16', sku: 'WOO-BAG-1', name: 'Plecak miejski', url: shopUrl('product/plecak-miejski/'), price: PLN('99.00'), status: 'active' },
  { externalId: '17', sku: 'WOO-GIFT-100', name: 'Karta podarunkowa 100 zł', url: shopUrl('product/karta-podarunkowa-100-zl/'), price: PLN('100.00'), status: 'active' },
  { externalId: '19:20', sku: 'WOO-TSHIRT-S', name: 'Koszulka testowa - S', url: shopUrl('product/koszulka-testowa/?attribute_rozmiar=S'), price: PLN('79.00'), status: 'active' },
  // No SKU of its own: WooCommerce reports the parent's, which is not this Offer's.
  { externalId: '19:21', sku: null, name: 'Koszulka testowa - M', url: shopUrl('product/koszulka-testowa/?attribute_rozmiar=M'), price: PLN('79.00'), status: 'active' },
  // Leaves its stock to the parent (`manage_stock: "parent"`): an Offer like its siblings.
  { externalId: '19:22', sku: 'WOO-TSHIRT-L', name: 'Koszulka testowa - L', url: shopUrl('product/koszulka-testowa/?attribute_rozmiar=L'), price: PLN('79.00'), status: 'active' },
  // Not enabled.
  { externalId: '19:23', sku: 'WOO-TSHIRT-XL', name: 'Koszulka testowa - XL', url: shopUrl('product/koszulka-testowa/?attribute_rozmiar=XL'), price: PLN('89.00'), status: 'inactive' },
  { externalId: '24:25', sku: 'WOO-HOODIE-BLK-M', name: 'Bluza testowa - Czarny, M', url: shopUrl('product/bluza-testowa/?attribute_kolor=Czarny&attribute_rozmiar=M'), price: PLN('159.00'), status: 'active' },
  { externalId: '24:26', sku: null, name: 'Bluza testowa - Szary, L', url: shopUrl('product/bluza-testowa/?attribute_kolor=Szary&attribute_rozmiar=L'), price: PLN('159.00'), status: 'active' },
]

describe('offers.pull against the recorded shop', () => {
  it('lists every simple product and every variation over several pages, by id', () =>
    withScenario('offers-listing', async (scenario) => {
      const connector = createWooCommerceConnector({ pageSize: 3 })
      const pages = await pullAll((cursor) => connector.capabilities['offers.pull']!(scenario.context(), cursor))

      expect(offersOf(pages)).toEqual(SEED_OFFERS)
      for (const offer of offersOf(pages)) expect(offerSchema.safeParse(offer).success).toBe(true)
      expect(pages.map((page) => [page.cursor, page.items.map((offer) => offer.externalId)])).toEqual([
        [null, ['10', '11', '12']],
        ['o1:PLN:2:12', ['13', '14', '15']],
        ['o1:PLN:3:15', ['16', '17', '19:20', '19:21', '19:22', '19:23']],
        ['o1:PLN:4:19', ['24:25', '24:26']],
      ])
      expect(pages.at(-1)).toMatchObject({ hasMore: false, nextCursor: null })
      expect(scenario.requests).toEqual([
        'GET data/currencies/current?_fields=code',
        `GET products?per_page=3&page=1${PRODUCTS}`,
        `GET products?per_page=3&page=2${PRODUCTS}`,
        `GET products?per_page=3&page=3${PRODUCTS}`,
        `GET products/19/variations?per_page=3&page=1${VARIATIONS}`,
        `GET products/19/variations?per_page=3&page=2${VARIATIONS}`,
        `GET products?per_page=3&page=4${PRODUCTS}`,
        `GET products/24/variations?per_page=3&page=1${VARIATIONS}`,
      ])
      expect(scenario.logs).toEqual([])
    }))

  it('returns the same Offers in the same order when a call may make one variation request only', () =>
    withScenario(
      'offers-listing',
      async (scenario) => {
        const pages = await pullAll((cursor) => pullOffers(scenario.context(), cursor, { pageSize: 3, maxVariationRequests: 1 }))

        expect(offersOf(pages)).toEqual(SEED_OFFERS)
        expect(pages.map((page) => [page.cursor, page.items.map((offer) => offer.externalId)])).toEqual([
          [null, ['10', '11', '12']],
          ['o1:PLN:2:12', ['13', '14', '15']],
          // Stops in the middle of product 19: its second page of variations waits for the next call.
          ['o1:PLN:3:15', ['16', '17', '19:20', '19:21', '19:22']],
          ['o1:PLN:3:17:19:2:22', ['19:23']],
          ['o1:PLN:4:19', ['24:25', '24:26']],
        ])
      },
      { reuse: true },
    ))

  it('pulls Offers without prices when the key may not read the shop currency', { timeout: 120_000 }, () =>
    withScenario(
      'offers-currency-forbidden',
      async (scenario) => {
        const connector = createWooCommerceConnector()
        const pages = await pullAll((cursor) => connector.capabilities['offers.pull']!(scenario.context(), cursor))

        expect(pages).toHaveLength(1)
        expect(offersOf(pages)).toEqual(SEED_OFFERS.map((offer) => ({ ...offer, price: null })))
        expect(scenario.requests).toEqual([
          'GET data/currencies/current?_fields=code',
          `GET products?per_page=100&page=1${PRODUCTS}`,
          `GET products/19/variations?per_page=100&page=1${VARIATIONS}`,
          `GET products/24/variations?per_page=100&page=1${VARIATIONS}`,
        ])
        // Once, and nothing of the key in it.
        expect(scenario.logs).toEqual([{ message: 'WooCommerce: the key may not read the shop currency, so Offers are pulled without prices' }])
      },
      {
        // The currency is a shop setting, which only somebody who may manage WooCommerce reads; the catalogue is not.
        prepare: (sandbox) => sandbox.wp('cap', 'remove', 'administrator', 'manage_woocommerce'),
        restore: (sandbox) => sandbox.wp('cap', 'add', 'administrator', 'manage_woocommerce'),
      },
    ))

  it('fails as permanent, not as signed out, when the key may read nothing (403 everywhere)', () =>
    withScenario('offers-forbidden', async (scenario) => {
      const connector = createWooCommerceConnector({ pageSize: 3 })
      await expect(connector.capabilities['offers.pull']!(scenario.context('noCapability'), null)).rejects.toMatchObject({
        name: 'PermanentError',
        kind: 'permanent',
        message: expect.stringMatching(/^403\b/),
      })
      // The currency could not be read, and the pull did not take that for an answer.
      expect(scenario.requests).toEqual(['GET data/currencies/current?_fields=code', `GET products?per_page=3&page=1${PRODUCTS}`])
    }))
})

// --- A shop in memory, for what a recording cannot show -----------------------------------------------------------

type Json = Record<string, unknown>

interface StubShop {
  products: Json[]
  /** Variations by parent id. */
  variations?: Record<number, Json[]>
  /** Whether lists carry `Link` and `X-WP-TotalPages`, as WordPress sends them. Default true. */
  pagingHeaders?: boolean
  /** Answers instead of the shop, when it returns one. */
  intercept?(request: { path: string; url: URL; call: number }): Response | undefined
}

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=UTF-8' }, ...init })
// WooCommerce's own refusals, as the sandbox worded them.
const wooError = (status: number, code: string, headers: Record<string, string> = {}) =>
  json({ code, message: 'Sorry, you cannot list resources.', data: { status } }, { status, headers: { 'content-type': 'application/json; charset=UTF-8', ...headers } })

const simple = (id: number, overrides: Json = {}) => rawSimpleProduct({ id, name: `Product ${id}`, sku: `SKU-${id}`, permalink: shopUrl(`product/${id}/`), ...overrides })
const variable = (id: number, overrides: Json = {}) => rawVariableProduct({ id, name: `Parent ${id}`, sku: '', permalink: shopUrl(`product/${id}/`), ...overrides })
const variation = (id: number, overrides: Json = {}) =>
  rawVariation({ id, sku: `SKU-${id}`, permalink: shopUrl(`product/x/?v=${id}`), attributes: [{ id: 0, name: 'Rozmiar', slug: 'rozmiar', option: `V${id}` }], ...overrides })

function stubShop(shop: StubShop) {
  const requests: string[] = []
  const list = (items: Json[], url: URL): Response => {
    const perPage = Number(url.searchParams.get('per_page'))
    const page = Number(url.searchParams.get('page'))
    const sorted = [...items].sort((a, b) => (a.id as number) - (b.id as number))
    const totalPages = Math.ceil(sorted.length / perPage)
    const headers: Record<string, string> = { 'content-type': 'application/json; charset=UTF-8' }
    if (shop.pagingHeaders !== false) {
      headers['x-wp-total'] = String(sorted.length)
      headers['x-wp-totalpages'] = String(totalPages)
      headers.link = page < totalPages ? `<${url.origin}${url.pathname}?page=${page + 1}>; rel="next"` : `<${url.origin}/wp-json/>; rel="https://api.w.org/"`
    }
    return json(sorted.slice((page - 1) * perPage, page * perPage), { headers })
  }
  const ctx: WooCommerceContext & { logs: string[] } = {
    app: {},
    config: replayConfig,
    credentials: replayCredentials,
    logs: [],
    log(message) {
      this.logs.push(message)
    },
    fetch: async (input) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/wp-json/wc/v3/', '')
      requests.push(`${path}${decodeURIComponent(url.search)}`)
      const intercepted = shop.intercept?.({ path, url, call: requests.length })
      if (intercepted !== undefined) return intercepted
      if (path === 'data/currencies/current') return json({ code: 'PLN' })
      if (path === 'products') return list(shop.products, url)
      const parent = /^products\/(\d+)\/variations$/.exec(path)
      if (parent !== null) return list(shop.variations?.[Number(parent[1])] ?? [], url)
      return wooError(404, 'rest_no_route')
    },
  }
  return { ctx, requests }
}

describe('the offers.pull cursor', () => {
  it.each([
    [{ currency: 'PLN', page: 1, after: 0, parent: null }, 'o1:PLN:1:0'],
    [{ currency: null, page: 7, after: 1234, parent: null }, 'o1:-:7:1234'],
    [{ currency: 'EUR', page: 3, after: 17, parent: { id: 19, page: 2, after: 22 } }, 'o1:EUR:3:17:19:2:22'],
    [{ currency: null, page: 3, after: 17, parent: { id: 19, page: 2, after: 0 } }, 'o1:-:3:17:19:2:0'],
  ])('writes %j as %s and reads it back', (position, cursor) => {
    expect(formatOffersCursor(position)).toBe(cursor)
    expect(parseOffersCursor(cursor)).toEqual(position)
  })

  it.each([
    '',
    'o1',
    'o2:PLN:1:0',
    'PLN:1:0',
    'o1:pln:1:0',
    'o1:PLNX:1:0',
    'o1::1:0',
    'o1:PLN:0:0',
    'o1:PLN:1',
    'o1:PLN:1:-1',
    'o1:PLN:1.5:0',
    'o1:PLN:1:0:19',
    'o1:PLN:1:0:19:2',
    'o1:PLN:1:0:0:2:22',
    'o1:PLN:1:0:19:0:22',
    'o1:PLN:1:0:19:2:22:1',
    'o1:PLN:99999999999999999999:0',
    'o1:PLN:1:0:19:2:99999999999999999999',
    ' o1:PLN:1:0',
    'l1:2026-10-10T19:00:00Z:57:0',
  ])('refuses the cursor %j as permanent, without a request', async (cursor) => {
    const { ctx, requests } = stubShop({ products: [simple(10)] })
    expect(() => parseOffersCursor(cursor)).toThrow(/cursor/)
    await expect(pullOffers(ctx, cursor, { pageSize: 100 })).rejects.toMatchObject({ name: 'PermanentError', kind: 'permanent' })
    expect(requests).toEqual([])
  })
})

describe('offers.pull, one call', () => {
  it('asks for the currency once, in the first call, and carries it in the cursor', async () => {
    const { ctx, requests } = stubShop({ products: [10, 11, 12, 13, 14].map((id) => simple(id)) })
    const pages = await pullAll((cursor) => pullOffers(ctx, cursor, { pageSize: 2 }))
    expect(requests).toEqual([
      'data/currencies/current?_fields=code',
      `products?per_page=2&page=1${PRODUCTS}`,
      `products?per_page=2&page=2${PRODUCTS}`,
      `products?per_page=2&page=3${PRODUCTS}`,
    ])
    expect(pages.map((page) => page.cursor)).toEqual([null, 'o1:PLN:2:11', 'o1:PLN:3:13'])
    expect(offersOf(pages).every((offer) => offer.price?.currency === 'PLN')).toBe(true)
  })

  it('makes a bounded number of requests when every product of a page is variable', async () => {
    const parents = Array.from({ length: 100 }, (_, index) => 1000 + index)
    const { ctx, requests } = stubShop({
      products: parents.map((id) => variable(id)),
      variations: Object.fromEntries(parents.map((id) => [id, [variation(id * 10 + 1), variation(id * 10 + 2)]])),
    })
    const perCall: number[] = []
    const pages = await pullAll(async (cursor) => {
      const before = requests.length
      const page = await pullOffers(ctx, cursor, { pageSize: 100 })
      perCall.push(requests.length - before)
      return page
    })

    // The currency, the products page and 25 variation lists; afterwards the page again and 25 more.
    expect(perCall).toEqual([MAX_VARIATION_REQUESTS + 2, MAX_VARIATION_REQUESTS + 1, MAX_VARIATION_REQUESTS + 1, MAX_VARIATION_REQUESTS + 1])
    expect(Math.max(...perCall)).toBeLessThan(100)
    expect(pages.map((page) => page.cursor)).toEqual([null, 'o1:PLN:1:1024', 'o1:PLN:1:1049', 'o1:PLN:1:1074'])
    expect(idsOf(pages)).toEqual(parents.flatMap((id) => [`${id}:${id * 10 + 1}`, `${id}:${id * 10 + 2}`]))
  })

  it('resumes inside a variable product whose variations fill more pages than a call may read', async () => {
    const variations = Array.from({ length: 11 }, (_, index) => variation(500 + index))
    const { ctx, requests } = stubShop({ products: [simple(10), variable(19), simple(30), variable(40)], variations: { 19: variations, 40: [variation(900)] } })
    const pages = await pullAll((cursor) => pullOffers(ctx, cursor, { pageSize: 4, maxVariationRequests: 2 }))

    expect(pages.map((page) => [page.cursor, page.items.map((offer) => offer.externalId)])).toEqual([
      [null, ['10', '19:500', '19:501', '19:502', '19:503', '19:504', '19:505', '19:506', '19:507']],
      // The simple product after 19 waits until 19 is done: Offers come in the order of their products.
      ['o1:PLN:1:10:19:3:507', ['19:508', '19:509', '19:510', '30', '40:900']],
    ])
    expect(requests.filter((request) => request.startsWith('products?'))).toHaveLength(2)
    expect(new Set(idsOf(pages)).size).toBe(idsOf(pages).length)
  })

  it('never stops where it started: a budget below 1 counts as 1', async () => {
    const { ctx } = stubShop({ products: [variable(19), variable(24)], variations: { 19: [variation(20)], 24: [variation(25)] } })
    const pages = await pullAll((cursor) => pullOffers(ctx, cursor, { pageSize: 100, maxVariationRequests: 0 }))
    expect(pages.map((page) => page.cursor)).toEqual([null, 'o1:PLN:1:19'])
    expect(idsOf(pages)).toEqual(['19:20', '24:25'])
  })

  it('sends no Offer twice when a product comes back from the trash and the later ones move down a page', async () => {
    const shop: StubShop = { products: [10, 11, 12, 13, 14, 15].map((id) => simple(id)) }
    const { ctx } = stubShop(shop)
    const first = await pullOffers(ctx, null, { pageSize: 2 })
    expect(first.items.map((offer) => offer.externalId)).toEqual(['10', '11'])

    // Page 2 is now 11 and 12. Product 5 itself is behind the cursor: the next pull has it.
    shop.products = [simple(5), ...shop.products]
    const rest = await pullAll((cursor) => pullOffers(ctx, cursor, { pageSize: 2 }), first.nextCursor)
    expect(idsOf(rest)).toEqual(['12', '13', '14', '15'])
  })

  it('can miss an Offer until the next pull when a product is deleted while it runs, and still sends none twice', async () => {
    const shop: StubShop = { products: [10, 11, 12, 13, 14, 15].map((id) => simple(id)) }
    const { ctx } = stubShop(shop)
    const first = await pullOffers(ctx, null, { pageSize: 2 })

    // Page 2 is now 13 and 14: product 12 moved up to the page already read.
    shop.products = shop.products.filter((product) => product.id !== 10)
    const rest = await pullAll((cursor) => pullOffers(ctx, cursor, { pageSize: 2 }), first.nextCursor)
    expect([...first.items.map((offer) => offer.externalId), ...idsOf(rest)]).toEqual(['10', '11', '13', '14', '15'])
  })

  it('goes on after a variable product that was deleted while its page was being read', async () => {
    const { ctx } = stubShop({
      products: [variable(19), simple(30)],
      intercept: ({ path }) => (path === 'products/19/variations' ? wooError(404, 'woocommerce_rest_product_invalid_id') : undefined),
    })
    const pages = await pullAll((cursor) => pullOffers(ctx, cursor, { pageSize: 100 }))
    expect(idsOf(pages)).toEqual(['30'])
  })

  it('skips grouped and external products and the types plugins add', async () => {
    const { ctx, requests } = stubShop({
      products: [simple(10), simple(11, { type: 'grouped' }), simple(12, { type: 'external' }), simple(13, { type: 'subscription' }), simple(14, { type: 'bundle' }), simple(15)],
    })
    const pages = await pullAll((cursor) => pullOffers(ctx, cursor, { pageSize: 100 }))
    expect(idsOf(pages)).toEqual(['10', '15'])
    expect(requests).toHaveLength(2)
  })

  it('reads on by the size of the page where a proxy dropped the paging headers', async () => {
    const { ctx, requests } = stubShop({
      products: [10, 11, 12, 13].map((id) => simple(id)),
      pagingHeaders: false,
    })
    const pages = await pullAll((cursor) => pullOffers(ctx, cursor, { pageSize: 2 }))
    expect(idsOf(pages)).toEqual(['10', '11', '12', '13'])
    // A full last page costs one request for the empty page after it.
    expect(requests.filter((request) => request.startsWith('products?')).map((request) => /[?&]page=(\d+)/.exec(request)![1])).toEqual(['1', '2', '3'])
    expect(pages.at(-1)).toMatchObject({ items: [], hasMore: false, nextCursor: null })
  })

  it('reads on by the size of the page for variations too', async () => {
    const { ctx } = stubShop({ products: [variable(19)], variations: { 19: [20, 21, 22].map((id) => variation(id)) }, pagingHeaders: false })
    const pages = await pullAll((cursor) => pullOffers(ctx, cursor, { pageSize: 2 }))
    expect(idsOf(pages)).toEqual(['19:20', '19:21', '19:22'])
  })

  it.each<[string, StubShop]>([
    ['products', { products: [simple(11), simple(10)] }],
    ['variations', { products: [variable(19)], variations: { 19: [variation(21), variation(20)] } }],
  ])('fails as permanent when the shop does not list its %s by id', async (what, shop) => {
    // The stub sorts like WooCommerce does, so hand the lists over as they are.
    const { ctx } = stubShop({
      ...shop,
      intercept: ({ path }) => {
        if (path === 'products') return json(shop.products)
        if (path === 'products/19/variations') return json(shop.variations?.[19] ?? [])
        return undefined
      },
    })
    await expect(pullOffers(ctx, null, { pageSize: 100 })).rejects.toMatchObject({ kind: 'permanent', message: `The shop did not list its ${what} by id, so they cannot be paged` })
  })
})

describe('offers.pull and a shop that sends more than a shop does', () => {
  const megabyte = 'x'.repeat(1024 * 1024)

  it('keeps the page when one product has a name, a SKU, a price and a link longer than any: that Offer loses them', async () => {
    const { ctx } = stubShop({
      products: [simple(10), simple(11, { name: `Kubek ${megabyte}`, sku: megabyte, price: `1${'0'.repeat(200)}`, permalink: shopUrl(megabyte) }), variable(19, { name: megabyte }), simple(30)],
      variations: { 19: [variation(20, { sku: megabyte, price: megabyte, permalink: megabyte, attributes: Array.from({ length: 300 }, () => ({ id: 0, name: 'Rozmiar', slug: 'rozmiar', option: 'x'.repeat(5000) })) })] },
    })
    const offers = offersOf(await pullAll((cursor) => pullOffers(ctx, cursor, { pageSize: 100 })))

    expect(offers.map((offer) => offer.externalId)).toEqual(['10', '11', '19:20', '30'])
    expect(offers[0]).toMatchObject({ sku: 'SKU-10', price: { amount: '49.99', currency: 'PLN' } })
    expect(offers[1]).toMatchObject({ sku: null, price: null, url: null })
    expect(offers[1]!.name).toHaveLength(1000)
    expect(offers[2]).toMatchObject({ sku: null, price: null, url: null })
    // A thousand characters of the parent's name, then twenty attribute values of a hundred each.
    expect(offers[2]!.name).toHaveLength(1000 + ' - '.length + 20 * 100 + 19 * ', '.length)
    for (const offer of offers) expect(offerSchema.safeParse(offer).success).toBe(true)
  })

  it.each<[string, StubShop, string]>([
    ['products', { products: Array.from({ length: 101 }, (_, index) => simple(index + 1)) }, 'Unexpected products response from the shop: (root) (too_big)'],
    ['variations', { products: [variable(19)], variations: { 19: Array.from({ length: 101 }, (_, index) => variation(index + 20)) } }, 'Unexpected variations response from the shop: (root) (too_big)'],
  ])('fails as permanent for a page of more %s than can be asked for', async (_, shop, message) => {
    const { ctx } = stubShop({
      ...shop,
      intercept: ({ path }) => {
        if (path === 'products') return json(shop.products)
        if (path === 'products/19/variations') return json(shop.variations?.[19] ?? [])
        return undefined
      },
    })
    await expect(pullOffers(ctx, null, { pageSize: 100 })).rejects.toMatchObject({ kind: 'permanent', message })
  })
})

describe('offers.pull and the shop currency', () => {
  it('reports no prices and says so once when the currency answers 403', async () => {
    const { ctx } = stubShop({
      products: [10, 11, 12].map((id) => simple(id)),
      intercept: ({ path }) => (path === 'data/currencies/current' ? wooError(403, 'woocommerce_rest_cannot_view') : undefined),
    })
    const pages = await pullAll((cursor) => pullOffers(ctx, cursor, { pageSize: 1 }))
    expect(pages).toHaveLength(3)
    expect(pages.map((page) => page.cursor)).toEqual([null, 'o1:-:2:10', 'o1:-:3:11'])
    expect(offersOf(pages).map((offer) => offer.price)).toEqual([null, null, null])
    expect(ctx.logs).toEqual(['WooCommerce: the key may not read the shop currency, so Offers are pulled without prices'])
  })

  it.each(['pts', 'zł', 'PLNX', ''])('reports no prices when the shop currency is %j, which is not an ISO 4217 code', async (code) => {
    const { ctx } = stubShop({ products: [simple(10)], intercept: ({ path }) => (path === 'data/currencies/current' ? json({ code }) : undefined) })
    const pages = await pullAll((cursor) => pullOffers(ctx, cursor, { pageSize: 100 }))
    expect(offersOf(pages)).toMatchObject([{ externalId: '10', price: null }])
    expect(ctx.logs).toEqual(['WooCommerce: the shop currency is not an ISO 4217 code, so Offers are pulled without prices'])
  })

  it('does not take an unreadable currency for an answer when everything else is refused too (a bare 403)', async () => {
    const { ctx, requests } = stubShop({ products: [simple(10)], intercept: () => new Response(null, { status: 403, statusText: 'Forbidden' }) })
    await expect(pullOffers(ctx, null, { pageSize: 100 })).rejects.toMatchObject({ kind: 'permanent', message: '403 Forbidden' })
    expect(requests).toHaveLength(2)
  })

  it.each([
    [401, 'auth_expired'],
    [429, 'rate_limited'],
    [500, 'transient'],
    [404, 'permanent'],
  ])('fails the pull when the currency answers %i (%s): only a 403 means "not for this key"', async (status, kind) => {
    const { ctx, requests } = stubShop({ products: [simple(10)], intercept: ({ path }) => (path === 'data/currencies/current' ? wooError(status, 'some_code') : undefined) })
    await expect(pullOffers(ctx, null, { pageSize: 100 })).rejects.toMatchObject({ kind })
    expect(requests).toHaveLength(1)
  })
})

describe('offers.pull when the shop does not answer as expected', () => {
  const failing = (answer: () => Response) => stubShop({ products: [simple(10)], intercept: ({ path }) => (path === 'products' ? answer() : undefined) })

  it('401 → auth_expired', async () => {
    const { ctx } = failing(() => wooError(401, 'woocommerce_rest_authentication_error'))
    await expect(pullOffers(ctx, null, { pageSize: 100 })).rejects.toMatchObject({ name: 'AuthExpiredError', kind: 'auth_expired' })
  })

  it('403 → permanent', async () => {
    const { ctx } = failing(() => wooError(403, 'woocommerce_rest_cannot_view'))
    await expect(pullOffers(ctx, null, { pageSize: 100 })).rejects.toMatchObject({ name: 'PermanentError', kind: 'permanent' })
  })

  it('429 → rate_limited, with the wait the shop (or its firewall) asked for', async () => {
    const { ctx } = failing(() => wooError(429, 'too_many_requests', { 'retry-after': '17' }))
    await expect(pullOffers(ctx, null, { pageSize: 100 })).rejects.toMatchObject({ name: 'RateLimitedError', kind: 'rate_limited', retryAfterMs: 17_000 })
  })

  it('500 → transient', async () => {
    const { ctx } = failing(() => new Response('<h1>Error establishing a database connection</h1>', { status: 500, headers: { 'content-type': 'text/html' } }))
    await expect(pullOffers(ctx, null, { pageSize: 100 })).rejects.toMatchObject({ name: 'TransientError', kind: 'transient' })
  })

  it('a 200 that is not JSON (a firewall page) → permanent, without the page in the message', async () => {
    const { ctx } = failing(() => new Response('<html><body>Checking your browser, secret-token-123</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    await expect(pullOffers(ctx, null, { pageSize: 100 })).rejects.toMatchObject({ kind: 'permanent', message: 'Unexpected products response from the shop: not JSON' })
  })

  it('a product without an id → permanent, naming the field', async () => {
    const { ctx } = failing(() => json([{ name: 'x', type: 'simple', status: 'publish' }]))
    await expect(pullOffers(ctx, null, { pageSize: 100 })).rejects.toMatchObject({ kind: 'permanent', message: 'Unexpected products response from the shop: 0.id (invalid_type)' })
  })

  it('a failure in the middle of a call rejects the call, and the same cursor reads it again', async () => {
    let fail = true
    const { ctx } = stubShop({
      products: [simple(10), variable(19)],
      variations: { 19: [variation(20)] },
      intercept: ({ path }) => (path === 'products/19/variations' && fail ? new Response(null, { status: 502 }) : undefined),
    })
    await expect(pullOffers(ctx, null, { pageSize: 100 })).rejects.toMatchObject({ kind: 'transient' })
    fail = false
    expect((await pullOffers(ctx, null, { pageSize: 100 })).items.map((offer) => offer.externalId)).toEqual(['10', '19:20'])
  })
})
