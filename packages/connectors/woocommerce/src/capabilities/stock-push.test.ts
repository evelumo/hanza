import { stockPushResultSchema, type StockLevel, type StockPushResult } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { createWooCommerceConnector } from '../connector'
import type { WooCommerceContext } from '../settings'
import { withScenario } from '../testing/offer-scenario'
import { replayConfig, replayCredentials } from '../testing/recording'
import { rawSimpleProduct, rawVariableProduct, rawVariation } from '../testing/samples'
import { MAX_BATCH_ITEMS, pushStock, REJECTION } from './stock-push'

// The scenarios below replay cassettes recorded from the sandbox shop (sandbox/README.md). To record them again:
//
//   WOO_SANDBOX_PROJECT=<name> WOO_SANDBOX_PORT=<port> sandbox/sandbox.sh reset
//   WOO_SANDBOX_PROJECT=<name> WOO_SANDBOX_PORT=<port> HANZA_RECORD_FIXTURES=1 \
//     pnpm --filter @hanza/connector-woocommerce exec vitest run src/capabilities/stock-push.test.ts
//
// One test file at a time: a scenario that needs the shop in another state puts it there itself, and back, which
// would change the shop under a recording running next to it.

const level = (offerExternalId: string, available: number): StockLevel => ({ offerExternalId, sku: null, available })
const rejected = (offerExternalId: string, code: string): StockPushResult => ({ offerExternalId, outcome: 'rejected', code })

const connector = createWooCommerceConnector()
const push = (ctx: WooCommerceContext, levels: StockLevel[]) => connector.capabilities['stock.push']!(ctx, levels)

const TYPES = '&per_page=100&_fields=id,type'
const update = (...items: Array<[id: number, available: number]>) => ({ update: items.map(([id, available]) => ({ id, manage_stock: true, stock_quantity: available })) })

describe('stock.push against the recorded shop', () => {
  it('sets the numbers of simple products and variations, and names every Offer the shop refused', () =>
    withScenario(
      'stock-push',
      async (scenario) => {
        const levels = [
          level('10', 7),
          // Stock management is off for this product: the push turns it on.
          level('13', 4),
          // No such product.
          level('999999', 1),
          // A variation's id on its own: variations are not products.
          level('20', 1),
          // A variable product, as an Offer that was a simple product when it was pulled.
          level('19', 9),
          level('not-an-id', 1),
          level('19:20', 6),
          // Left its stock to the parent (`manage_stock: "parent"`): gets a number of its own.
          level('19:22', 3),
          // No such variation.
          level('19:999999', 2),
          // A variation of another product.
          level('24:20', 1),
        ]
        const expected = [
          rejected('999999', 'woocommerce_rest_product_invalid_id'),
          rejected('20', 'woocommerce_rest_product_invalid_id'),
          rejected('19', 'not_a_simple_product'),
          rejected('not-an-id', 'invalid_offer_id'),
          rejected('19:999999', 'woocommerce_rest_product_variation_invalid_id'),
          rejected('24:20', 'woocommerce_rest_product_variation_invalid_id'),
        ]
        expect(await push(scenario.context(), levels)).toEqual(expected)
        expect(scenario.requests).toEqual([
          `GET products?include=10,13,999999,20,19${TYPES}`,
          'POST products/batch',
          'POST products/19/variations/batch',
          'POST products/24/variations/batch',
        ])
        // The variable product 19, whose number its variations on "parent" stock sell from, was never sent.
        expect(scenario.bodies).toEqual([update([10, 7], [13, 4]), update([20, 6], [22, 3], [999999, 2]), update([20, 1])])
        // Again: the same state, the same answer.
        expect(await push(scenario.context(), levels)).toEqual(expected)
        expect(scenario.requests).toHaveLength(8)
      },
      {
        prepare: async (sandbox) => {
          await sandbox.put('products/13', { manage_stock: false })
          await sandbox.put('products/19/variations/22', { manage_stock: 'parent' })
        },
      },
    ))

  it('goes on after a parent that is gone, is not a variable product or is in the trash, and after a product in the trash', { timeout: 120_000 }, () =>
    withScenario(
      'stock-gone',
      async (scenario) => {
        const levels = [
          // A simple product in the trash: the shop does not list it, so it is not sent.
          level('17', 5),
          level('10', 8),
          // Under a product deleted for good, under a page, under a simple product: WooCommerce answers each of
          // these batches 200 and refuses the item in it.
          level('18:20', 1),
          level('2:20', 1),
          level('10:20', 1),
          // Under a variable product in the trash, where its variations went with it: WooCommerce sets the number.
          level('24:25', 4),
          level('19:21', 7),
        ]
        expect(await push(scenario.context(), levels)).toEqual([
          rejected('17', 'woocommerce_rest_product_invalid_id'),
          rejected('18:20', 'woocommerce_rest_product_variation_invalid_id'),
          rejected('2:20', 'woocommerce_rest_product_variation_invalid_id'),
          rejected('10:20', 'woocommerce_rest_product_variation_invalid_id'),
          rejected('24:25', 'woocommerce_rest_product_variation_invalid_id'),
        ])
        // Every batch was sent, the last one after four that applied nothing.
        expect(scenario.requests).toEqual([
          `GET products?include=17,10${TYPES}`,
          'POST products/batch',
          'POST products/18/variations/batch',
          'POST products/2/variations/batch',
          'POST products/10/variations/batch',
          'POST products/24/variations/batch',
          'POST products/19/variations/batch',
        ])
        expect(scenario.bodies).toEqual([update([10, 8]), update([20, 1]), update([20, 1]), update([20, 1]), update([25, 4]), update([21, 7])])
      },
      {
        prepare: (sandbox) => sandbox.wp('eval', 'wp_trash_post(24); wp_trash_post(17);'),
        restore: (sandbox) => sandbox.wp('eval', 'wp_untrash_post(24); wp_untrash_post(17);'),
      },
    ))

  it('pushes 0 without ending the Offer, as often as it is asked to', () =>
    withScenario('stock-push-zero', async (scenario) => {
      const levels = [level('10', 0), level('19:20', 0)]
      // WooCommerce keeps a product at 0 published (`stock_status: outofstock`), so nothing is `ended`.
      expect(await push(scenario.context(), levels)).toEqual([])
      expect(await push(scenario.context(), levels)).toEqual([])
      expect(await push(scenario.context(), [level('10', 5), level('19:20', 5)])).toEqual([])
      const call = [`GET products?include=10${TYPES}`, 'POST products/batch', 'POST products/19/variations/batch']
      expect(scenario.requests).toEqual([...call, ...call, ...call])
    }))

  it('reports every Offer rejected when stock management is off for the whole shop: a 200, and the numbers are not in use', () =>
    withScenario(
      'stock-not-managed',
      async (scenario) => {
        // The product answers with the number it had, the variation with the 12 it stored; both `manage_stock: false`.
        expect(await push(scenario.context(), [level('10', 12), level('19:20', 12)])).toEqual([rejected('10', 'stock_not_managed'), rejected('19:20', 'stock_not_managed')])
      },
      {
        prepare: (sandbox) => sandbox.put('settings/products/woocommerce_manage_stock', { value: 'no' }),
        restore: (sandbox) => sandbox.put('settings/products/woocommerce_manage_stock', { value: 'yes' }),
      },
    ))

  it('fails as signed out with a key that may only read (401)', () =>
    withScenario('stock-read-only', async (scenario) => {
      await expect(push(scenario.context('readOnly'), [level('10', 5)])).rejects.toMatchObject({ name: 'AuthExpiredError', kind: 'auth_expired' })
      // It may read what the product is; the write is refused.
      expect(scenario.requests).toEqual([`GET products?include=10${TYPES}`, 'POST products/batch'])
    }))

  it('fails as permanent with a key whose user may neither read nor edit products (403)', () =>
    withScenario('stock-forbidden', async (scenario) => {
      await expect(push(scenario.context('noCapability'), [level('10', 5), level('19:20', 5)])).rejects.toMatchObject({ name: 'PermanentError', kind: 'permanent' })
      // The first refusal ends the call.
      expect(scenario.requests).toEqual([`GET products?include=10${TYPES}`])
      await expect(push(scenario.context('noCapability'), [level('19:20', 5)])).rejects.toMatchObject({ name: 'PermanentError', kind: 'permanent' })
      expect(scenario.requests.slice(1)).toEqual(['POST products/19/variations/batch'])
    }))
})

// --- A shop in memory, for what a recording cannot show -----------------------------------------------------------

type Json = Record<string, unknown>

interface Sent {
  path: string
  method: string
  headers: Record<string, string>
  body: { update: Array<{ id: number; manage_stock: boolean; stock_quantity: number }> }
}

interface StubShop {
  /** What the shop says a product is; null for one it does not list. Every other id is a simple product. */
  types?: Record<number, string | null>
  /** Answers the read of what the products are, instead of `types`. */
  read?(): Response
}

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=UTF-8' }, ...init })

/** What WooCommerce answers for an item it applied: the whole product or variation. */
function echo(path: string, item: Sent['body']['update'][number]): Json {
  const overrides = { id: item.id, manage_stock: item.manage_stock, stock_quantity: item.stock_quantity }
  return path === 'products/batch' ? rawSimpleProduct(overrides) : rawVariation(overrides)
}

/** A shop that applies every item of a batch, unless `answer` says otherwise for one. `sent` holds the batches, `reads` the reads. */
function stubShop(answer?: (sent: Sent, call: number) => Response | Json[] | undefined, shop: StubShop = {}) {
  const sent: Sent[] = []
  const reads: string[] = []
  const order: string[] = []
  const ctx: WooCommerceContext = {
    app: {},
    config: replayConfig,
    credentials: replayCredentials,
    log: () => {},
    fetch: async (input, init = {}) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/wp-json/wc/v3/', '')
      const method = init.method ?? 'GET'
      order.push(`${method} ${path}`)
      if (method === 'GET') {
        reads.push(`${path}${decodeURIComponent(url.search)}`)
        if (shop.read) return shop.read()
        const ids = (url.searchParams.get('include') ?? '').split(',').map(Number)
        return json(ids.flatMap((id) => (shop.types?.[id] === null ? [] : [{ id, type: shop.types?.[id] ?? 'simple' }])))
      }
      const request: Sent = {
        path,
        method,
        headers: Object.fromEntries(Object.entries(init.headers as Record<string, string>).filter(([name]) => name !== 'authorization')),
        body: JSON.parse(String(init.body)) as Sent['body'],
      }
      sent.push(request)
      const custom = answer?.(request, sent.length)
      if (custom instanceof Response) return custom
      return json({ update: custom ?? request.body.update.map((item) => echo(request.path, item)) })
    },
  }
  return { ctx, sent, reads, order }
}

describe('stock.push requests', () => {
  it('makes no request for no levels', async () => {
    const { ctx, order } = stubShop()
    expect(await pushStock(ctx, [])).toEqual([])
    expect(order).toEqual([])
  })

  it('sends one products batch and one variations batch per parent, turning stock management on', async () => {
    const { ctx, sent, order } = stubShop()
    const results = await pushStock(ctx, [level('19:20', 6), level('10', 7), level('24:25', 0), level('19:22', 3), level('13', 0)])

    expect(results).toEqual([])
    expect(order).toEqual(['GET products', 'POST products/batch', 'POST products/19/variations/batch', 'POST products/24/variations/batch'])
    expect(sent).toEqual([
      {
        path: 'products/batch',
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: update([10, 7], [13, 0]),
      },
      {
        path: 'products/19/variations/batch',
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: update([20, 6], [22, 3]),
      },
      {
        path: 'products/24/variations/batch',
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: update([25, 0]),
      },
    ])
  })

  it('makes no request for an Offer id that is neither of the two forms', async () => {
    const { ctx, order } = stubShop()
    const ids = ['abc', '0', '010', '19:', ':20', '19:20:21', '19-20', ' 10', '1.5', '-3', '99999999999999999999']
    expect(await pushStock(ctx, ids.map((id) => level(id, 1)))).toEqual(ids.map((id) => rejected(id, 'invalid_offer_id')))
    expect(order).toEqual([])
  })

  it('splits 100 levels across the endpoints they belong to', async () => {
    const { ctx, sent, reads } = stubShop()
    const levels = [
      ...Array.from({ length: 40 }, (_, index) => level(String(1000 + index), index)),
      ...Array.from({ length: 35 }, (_, index) => level(`19:${2000 + index}`, index)),
      ...Array.from({ length: 24 }, (_, index) => level(`24:${3000 + index}`, index)),
      level('30:4000', 1),
    ]
    expect(levels).toHaveLength(100)
    expect(await pushStock(ctx, levels)).toEqual([])
    expect(reads).toEqual([`products?include=${Array.from({ length: 40 }, (_, index) => 1000 + index).join(',')}${TYPES}`])
    expect(sent.map((request) => [request.path, request.body.update.length])).toEqual([
      ['products/batch', 40],
      ['products/19/variations/batch', 35],
      ['products/24/variations/batch', 24],
      ['products/30/variations/batch', 1],
    ])
    expect(sent.flatMap((request) => request.body.update.map((item) => item.id))).toEqual(levels.map(({ offerExternalId }) => Number(offerExternalId.split(':').at(-1))))
  })

  it('sends 100 simple products in one request, and never more in one', async () => {
    const { ctx, sent, reads } = stubShop()
    await pushStock(ctx, Array.from({ length: MAX_BATCH_ITEMS }, (_, index) => level(String(index + 1), 1)))
    expect(sent.map((request) => request.body.update.length)).toEqual([100])
    expect(reads).toHaveLength(1)

    // More than the contract's 100 levels: WooCommerce would refuse a batch of 101 as a whole (413), and a read
    // lists 100 products at most.
    const more = stubShop()
    await pushStock(more.ctx, [
      ...Array.from({ length: 150 }, (_, index) => level(String(index + 1), 1)),
      ...Array.from({ length: 101 }, (_, index) => level(`19:${index + 1}`, 1)),
    ])
    expect(more.order).toEqual([
      'GET products',
      'POST products/batch',
      'GET products',
      'POST products/batch',
      'POST products/19/variations/batch',
      'POST products/19/variations/batch',
    ])
    expect(more.reads.map((read) => /include=([\d,]+)/.exec(read)![1]!.split(',').length)).toEqual([100, 50])
    expect(more.sent.map((request) => request.body.update.length)).toEqual([100, 50, 100, 1])
  })

  it('sends an Offer given twice once, with its last number', async () => {
    const { ctx, sent } = stubShop()
    expect(await pushStock(ctx, [level('10', 1), level('19:20', 2), level('10', 3)])).toEqual([])
    expect(sent.map((request) => request.body)).toEqual([update([10, 3]), update([20, 2])])
  })
})

describe('stock.push reads what a product is before it writes to it', () => {
  it('sends only the simple products, and rejects the rest without a write', async () => {
    const { ctx, sent, reads } = stubShop(undefined, { types: { 19: 'variable', 27: 'grouped', 28: 'external', 30: 'subscription', 999999: null, 20: null } })
    const results = await pushStock(ctx, [level('10', 1), level('19', 2), level('27', 3), level('28', 4), level('30', 5), level('999999', 6), level('20', 7), level('11', 8)])

    expect(results).toEqual([
      // Made variable since it was pulled: its number is the one its variations on "parent" stock sell from.
      rejected('19', 'not_a_simple_product'),
      rejected('27', 'not_a_simple_product'),
      rejected('28', 'not_a_simple_product'),
      rejected('30', 'not_a_simple_product'),
      // Not listed (gone, in the trash, or a variation's id): as WooCommerce names an id it does not have.
      rejected('999999', 'woocommerce_rest_product_invalid_id'),
      rejected('20', 'woocommerce_rest_product_invalid_id'),
    ])
    expect(reads).toEqual([`products?include=10,19,27,28,30,999999,20,11${TYPES}`])
    expect(sent.map((request) => request.body)).toEqual([update([10, 1], [11, 8])])
  })

  it('sends no batch when none of the products is a simple one', async () => {
    const { ctx, order } = stubShop(undefined, { types: { 19: 'variable', 999999: null } })
    expect(await pushStock(ctx, [level('19', 2), level('999999', 6), level('24:25', 1)])).toEqual([rejected('19', 'not_a_simple_product'), rejected('999999', 'woocommerce_rest_product_invalid_id')])
    expect(order).toEqual(['GET products', 'POST products/24/variations/batch'])
  })

  it('does not read for variations: their batch names the parent, and WooCommerce refuses what is not under it', async () => {
    const { ctx, order } = stubShop()
    expect(await pushStock(ctx, [level('19:20', 2), level('24:25', 6)])).toEqual([])
    expect(order).toEqual(['POST products/19/variations/batch', 'POST products/24/variations/batch'])
  })

  it.each([
    [401, 'auth_expired'],
    [403, 'permanent'],
    [429, 'rate_limited'],
    [500, 'transient'],
  ])('fails the call, without a write, when the read answers %i', async (status, kind) => {
    const { ctx, sent } = stubShop(undefined, { read: () => new Response(null, { status }) })
    await expect(pushStock(ctx, [level('10', 5), level('19:20', 5)])).rejects.toMatchObject({ kind })
    expect(sent).toEqual([])
  })

  it.each([
    ['is not JSON', () => new Response('<html>Checking your browser</html>', { headers: { 'content-type': 'text/html' } }), 'Unexpected products response from the shop: not JSON'],
    ['is not a list', () => json({ code: 'rest_no_route' }), 'Unexpected products response from the shop: (root) (invalid_type)'],
    ['names no type', () => json([{ id: 10 }]), 'Unexpected products response from the shop: 0.type (invalid_type)'],
    ['lists more products than can be asked for', () => json(Array.from({ length: 101 }, (_, index) => ({ id: index + 1, type: 'simple' }))), 'Unexpected products response from the shop: (root) (too_big)'],
  ])('fails the call as permanent, without a write, when the read %s', async (_, read, message) => {
    const { ctx, sent } = stubShop(undefined, { read })
    await expect(pushStock(ctx, [level('10', 5)])).rejects.toMatchObject({ kind: 'permanent', message })
    expect(sent).toEqual([])
  })

  it('ignores products the read lists that were not asked for', async () => {
    const { ctx, sent } = stubShop(undefined, { read: () => json([{ id: 10, type: 'simple' }, { id: 77, type: 'simple' }]) })
    expect(await pushStock(ctx, [level('10', 5), level('11', 5)])).toEqual([rejected('11', 'woocommerce_rest_product_invalid_id')])
    expect(sent.map((request) => request.body)).toEqual([update([10, 5])])
  })
})

describe('stock.push results', () => {
  // Per-item refusals as the sandbox worded them.
  const refusal = (id: number, code: unknown, status: number) => ({ id, error: { code, message: 'Invalid ID.', data: { status } } })

  it('leaves an applied Offer out, also at 0: never ended', async () => {
    const { ctx } = stubShop()
    expect(await pushStock(ctx, [level('10', 0), level('19:20', 0), level('11', 12)])).toEqual([])
  })

  it('reports the code WooCommerce gave for an item, and applies the others', async () => {
    // A product deleted between the read and the write is refused in the batch.
    const { ctx } = stubShop(({ path, body }) =>
      path === 'products/batch'
        ? [echo(path, body.update[0]!), refusal(999999, 'woocommerce_rest_product_invalid_id', 400), refusal(20, 'woocommerce_rest_invalid_product_id', 404)]
        : [refusal(999999, 'woocommerce_rest_product_variation_invalid_id', 404), echo(path, body.update[1]!)],
    )
    const results = await pushStock(ctx, [level('10', 5), level('999999', 5), level('20', 5), level('19:999999', 5), level('19:21', 5)])
    expect(results).toEqual([
      rejected('999999', 'woocommerce_rest_product_invalid_id'),
      rejected('20', 'woocommerce_rest_invalid_product_id'),
      rejected('19:999999', 'woocommerce_rest_product_variation_invalid_id'),
    ])
    for (const result of results) expect(stockPushResultSchema.safeParse(result).success).toBe(true)
  })

  it.each([
    ['a sentence', 'Sorry, you are not allowed to edit Jan Testowy\'s product.'],
    ['an empty code', ''],
    ['a code of more than 100 characters', 'x'.repeat(101)],
    ['a code of a megabyte', 'x'.repeat(1024 * 1024)],
    ['a code with a space', 'invalid id'],
  ])('reports unknown_error for %s instead of passing it on', async (_, code) => {
    const { ctx } = stubShop(() => [refusal(10, code, 400)])
    expect(await pushStock(ctx, [level('10', 5)])).toEqual([rejected('10', 'unknown_error')])
  })

  it('reports a numeric error code as it is', async () => {
    const { ctx } = stubShop(() => [refusal(10, 500, 500)])
    expect(await pushStock(ctx, [level('10', 5)])).toEqual([rejected('10', '500')])
  })

  it.each([
    // The first three as the sandbox answered with the shop's stock management off.
    ['a simple product that kept the number it had', '10', { manage_stock: false, stock_quantity: 3 }],
    ['a simple product that never had a number', '10', { manage_stock: false, stock_quantity: null }],
    ['a variation that stores the number and does not use it', '19:20', { manage_stock: false, stock_quantity: 5 }],
    ['a variation still on its parent\'s stock', '19:20', { manage_stock: 'parent', stock_quantity: 5 }],
    ['another number than the one sent', '10', { manage_stock: true, stock_quantity: 4 }],
    ['an answer without the stock fields', '10', { manage_stock: undefined, stock_quantity: undefined }],
  ])('reports stock_not_managed for %s', async (_, offerExternalId, overrides) => {
    const { ctx } = stubShop(({ path, body }) => [{ ...echo(path, body.update[0]!), ...overrides }])
    expect(await pushStock(ctx, [level(offerExternalId, 5)])).toEqual([rejected(offerExternalId, 'stock_not_managed')])
  })

  // The second line of defence: the read said "simple", and the product was changed before the write arrived.
  it.each([
    ['a variable product', rawVariableProduct({ id: 19, manage_stock: true, stock_quantity: 5 })],
    ['a grouped product', rawSimpleProduct({ id: 19, type: 'grouped', manage_stock: false, stock_quantity: null })],
  ])('reports not_a_simple_product when the batch answers with %s', async (_, answer) => {
    const { ctx } = stubShop(() => [answer])
    expect(await pushStock(ctx, [level('19', 5)])).toEqual([rejected('19', 'not_a_simple_product')])
  })

  it('reports what the batch answers from the trash as not there, with the code of an unknown id', async () => {
    // As the sandbox answered for a variation whose parent is in the trash: updated like any other.
    const { ctx } = stubShop(({ path, body }) => [{ ...echo(path, body.update[0]!), status: 'trash' }])
    expect(await pushStock(ctx, [level('10', 5), level('24:25', 5)])).toEqual([
      rejected('10', 'woocommerce_rest_product_invalid_id'),
      rejected('24:25', 'woocommerce_rest_product_variation_invalid_id'),
    ])
  })

  it('takes an answer that does not say its type by its numbers', async () => {
    const { ctx } = stubShop(({ body }) => body.update.map((item) => ({ id: item.id, manage_stock: true, stock_quantity: item.stock_quantity })))
    expect(await pushStock(ctx, [level('10', 5), level('19:20', 0)])).toEqual([])
  })

  it('reports not_confirmed for an item the answer does not mention: left out, it would count as applied', async () => {
    const { ctx } = stubShop(({ path, body }) => (path === 'products/batch' ? [echo(path, body.update[1]!)] : []))
    expect(await pushStock(ctx, [level('10', 5), level('11', 5), level('19:20', 5)])).toEqual([rejected('10', 'not_confirmed'), rejected('19:20', 'not_confirmed')])
  })

  it('reports not_confirmed for every item of an answer without updates', async () => {
    const { ctx } = stubShop(() => json({}))
    expect(await pushStock(ctx, [level('10', 5)])).toEqual([rejected('10', 'not_confirmed')])
  })

  it('matches answers by id, in whatever order they come', async () => {
    const { ctx } = stubShop(({ path, body }) => [refusal(11, 'woocommerce_rest_product_invalid_id', 400), echo(path, body.update[0]!)])
    expect(await pushStock(ctx, [level('10', 5), level('11', 5)])).toEqual([rejected('11', 'woocommerce_rest_product_invalid_id')])
  })

  it('returns the results in the order of the levels', async () => {
    const { ctx } = stubShop(({ body }) => body.update.map((item) => refusal(item.id, 'refused', 400)), { types: { 12: 'variable', 13: null } })
    const ids = ['19:20', 'x', '10', '13', '24:25', '12', '11', '19:21']
    expect((await pushStock(ctx, ids.map((id) => level(id, 1)))).map((result) => result.offerExternalId)).toEqual(ids)
  })

  it('keeps its own codes within what a rejection code may be', () => {
    for (const code of Object.values(REJECTION)) expect(stockPushResultSchema.safeParse(rejected('10', code)).success).toBe(true)
  })
})

describe('stock.push when the whole call fails', () => {
  const wooError = (status: number, code: string, headers: Record<string, string> = {}) =>
    json({ code, message: 'Sorry, you are not allowed to batch manipulate this resource.', data: { status } }, { status, headers: { 'content-type': 'application/json; charset=UTF-8', ...headers } })

  it.each([
    [401, 'AuthExpiredError', 'auth_expired'],
    [403, 'PermanentError', 'permanent'],
    [404, 'PermanentError', 'permanent'],
    [413, 'PermanentError', 'permanent'],
    [500, 'TransientError', 'transient'],
    [503, 'TransientError', 'transient'],
  ])('a batch answered %i → %s', async (status, name, kind) => {
    const { ctx } = stubShop(() => wooError(status, 'some_code'))
    await expect(pushStock(ctx, [level('10', 5)])).rejects.toMatchObject({ name, kind })
    await expect(pushStock(ctx, [level('19:20', 5)])).rejects.toMatchObject({ name, kind })
  })

  it('429 → rate_limited, with the wait the shop (or its firewall) asked for', async () => {
    const { ctx } = stubShop(() => wooError(429, 'too_many_requests', { 'retry-after': '30' }))
    await expect(pushStock(ctx, [level('10', 5)])).rejects.toMatchObject({ name: 'RateLimitedError', kind: 'rate_limited', retryAfterMs: 30_000 })
  })

  it('a 200 that is not JSON (a firewall page) → permanent', async () => {
    const { ctx } = stubShop(() => new Response('<html>Checking your browser</html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    await expect(pushStock(ctx, [level('10', 5)])).rejects.toMatchObject({ kind: 'permanent', message: 'Unexpected stock update response from the shop: not JSON' })
  })

  it('an answer of another shape → permanent, naming the field', async () => {
    const { ctx } = stubShop(() => json({ update: [{ id: 'ten', manage_stock: true, stock_quantity: 5 }] }))
    await expect(pushStock(ctx, [level('10', 5)])).rejects.toMatchObject({ kind: 'permanent', message: 'Unexpected stock update response from the shop: update.0.id (invalid_type)' })
  })

  it('an answer with more items than a batch can hold → permanent', async () => {
    const { ctx } = stubShop(() => Array.from({ length: 101 }, (_, index) => ({ id: index + 1, manage_stock: true, stock_quantity: 5 })))
    await expect(pushStock(ctx, [level('10', 5)])).rejects.toMatchObject({ kind: 'permanent', message: 'Unexpected stock update response from the shop: update (too_big)' })
  })

  it('a shop that cannot be reached → transient', async () => {
    const { ctx } = stubShop()
    ctx.fetch = async () => {
      throw new TypeError('fetch failed')
    }
    await expect(pushStock(ctx, [level('10', 5)])).rejects.toMatchObject({ name: 'TransientError', kind: 'transient' })
  })

  it('rejects the call when a later batch fails, and the same call again applies everything', async () => {
    let down = true
    const { ctx, sent } = stubShop(({ path }) => (path === 'products/24/variations/batch' && down ? new Response(null, { status: 502 }) : undefined))
    const levels = [level('10', 5), level('19:20', 5), level('24:25', 5), level('30:31', 5)]
    await expect(pushStock(ctx, levels)).rejects.toMatchObject({ kind: 'transient' })
    // The batches before it were sent and applied; the one after it was not sent.
    expect(sent.map((request) => request.path)).toEqual(['products/batch', 'products/19/variations/batch', 'products/24/variations/batch'])

    down = false
    expect(await pushStock(ctx, levels)).toEqual([])
    expect(sent.slice(3).map((request) => request.path)).toEqual(['products/batch', 'products/19/variations/batch', 'products/24/variations/batch', 'products/30/variations/batch'])
    expect(sent[3]!.body).toEqual(sent[0]!.body)
  })
})
