import {
  AuthExpiredError,
  PermanentError,
  RateLimitedError,
  TransientError,
  classifyConnectorError,
  listCapabilities,
  offerSchema,
  orderSchema,
  type CapabilityContext,
} from '@hanza/connector-sdk'
import { assertConformance } from '@hanza/connector-sdk/testing'
import { describe, expect, it } from 'vitest'
import { createFakeChannel, fakeChannel, fakeConnector } from './index'
import { seedFacts, seedOffers, seedOrders } from './seed'

type FakeContext = CapabilityContext<{ failMode: 'none' | 'rate_limited' | 'transient' | 'permanent' }, { apiKey: string }>

const context = (overrides: Partial<FakeContext['config']> = {}, apiKey = 'test'): FakeContext => ({
  config: { failMode: 'none', ...overrides },
  credentials: { apiKey },
  fetch: async () => {
    throw new Error('the fake connector never uses the network')
  },
  log: () => {},
})

function pullOrders(channel = createFakeChannel()) {
  const pull = channel.connector.capabilities['orders.pull']!
  return { channel, pull: (cursor: string | null) => pull(context(), cursor) }
}

describe('fake connector', () => {
  it('passes the conformance kit', async () => {
    await assertConformance(createFakeChannel().connector, {
      config: { failMode: 'none' },
      credentials: { apiKey: 'test' },
      unauthorized: { credentials: { apiKey: 'expired' } },
    })
  })

  it('is a marketplace with all five capabilities, registered as `fake`', () => {
    expect(fakeConnector).toBe(fakeChannel.connector)
    expect(fakeConnector.id).toBe('fake')
    expect(fakeConnector.kind).toBe('marketplace')
    expect(listCapabilities(fakeConnector)).toEqual(['offers.pull', 'orders.pull', 'stock.push', 'price.push', 'orders.updateStatus'])
  })

  it('has a seed that satisfies the canonical schemas', () => {
    seedOffers.forEach((offer) => expect(offerSchema.parse(offer)).toEqual(offer))
    seedOrders.forEach((order) => expect(orderSchema.parse(order)).toEqual(order))
    seedFacts.forEach(({ fact }) => expect(fact.id).toBe('fake-order-2:cancelled'))
  })
})

describe('offers.pull', () => {
  it('pages the five seed Offers in twos with offset cursors', async () => {
    const pull = createFakeChannel().connector.capabilities['offers.pull']!
    const first = await pull(context(), null)
    expect(first.items.map((offer) => offer.externalId)).toEqual(['fake-offer-1', 'fake-offer-2'])
    expect(first).toMatchObject({ nextCursor: '2', hasMore: true })
    const second = await pull(context(), first.nextCursor)
    expect(second.items.map((offer) => offer.externalId)).toEqual(['fake-offer-3', 'fake-offer-4'])
    const third = await pull(context(), second.nextCursor)
    expect(third.items.map((offer) => offer.externalId)).toEqual(['fake-offer-5'])
    expect(third).toMatchObject({ nextCursor: '5', hasMore: false })
  })

  it('returns Offers added later and replaces an Offer with the same externalId', async () => {
    const channel = createFakeChannel()
    channel.addOffer({ externalId: 'fake-offer-6', sku: 'FAKE-SKU-6', name: 'New offer', url: null })
    channel.addOffer({ externalId: 'fake-offer-1', sku: 'FAKE-SKU-1', name: 'Large mug', url: null })
    const pull = channel.connector.capabilities['offers.pull']!
    const last = await pull(context(), '4')
    expect(last.items.map((offer) => offer.externalId)).toEqual(['fake-offer-5', 'fake-offer-6'])
    expect((await pull(context(), null)).items[0]?.name).toBe('Large mug')
  })
})

describe('orders.pull', () => {
  it('serves the five journal entries in pages of two and ends with cursor "5"', async () => {
    const { pull } = pullOrders()
    const first = await pull(null)
    expect(first.items.map((order) => order.externalId)).toEqual(['fake-order-1', 'fake-order-2'])
    expect(first).toMatchObject({ nextCursor: '2', hasMore: true })
    const second = await pull('2')
    expect(second.items.map((order) => order.externalId)).toEqual(['fake-order-3', 'fake-order-4'])
    expect(second).toMatchObject({ nextCursor: '4', hasMore: true })
    const third = await pull('4')
    expect(third.items.map((order) => order.externalId)).toEqual(['fake-order-2'])
    expect(third).toMatchObject({ nextCursor: '5', hasMore: false })
  })

  it('returns the current Order, with its fact, for every journal entry of that Order', async () => {
    const { pull } = pullOrders()
    const [, secondOrder] = (await pull(null)).items
    const [again] = (await pull('4')).items
    expect(secondOrder?.facts).toEqual(again?.facts)
    expect(again?.facts).toEqual([
      {
        id: 'fake-order-2:cancelled',
        type: 'cancelled',
        occurredAt: '2026-10-02T10:00:00Z',
        note: 'Cancelled by the buyer',
      },
    ])
  })

  it('is empty after the final cursor and keeps the cursor', async () => {
    const { pull } = pullOrders()
    expect(await pull('5')).toEqual({ items: [], nextCursor: '5', hasMore: false })
  })

  it('returns the same page for the same cursor', async () => {
    const { pull } = pullOrders()
    expect(await pull('2')).toEqual(await pull('2'))
  })

  it('shows the seed data the stage 1 end-to-end test relies on', async () => {
    const { pull } = pullOrders()
    const orders = (await pull(null)).items.concat((await pull('2')).items)
    const byId = new Map(orders.map((order) => [order.externalId, order]))
    expect(byId.get('fake-order-1')).toMatchObject({ payment: 'prepaid', total: { amount: '79.98', currency: 'PLN' } })
    expect(byId.get('fake-order-2')).toMatchObject({ payment: 'cash_on_delivery', total: { amount: '84.00', currency: 'PLN' } })
    expect(byId.get('fake-order-3')?.lines[0]).toMatchObject({ offerExternalId: null, sku: 'UNKNOWN-SKU' })
    expect(byId.get('fake-order-4')?.lines[0]).toMatchObject({ offerExternalId: 'fake-offer-4', sku: null, quantity: 3 })
  })

  it('addFact appends the fact and makes the Order reappear after the last cursor', async () => {
    const { channel, pull } = pullOrders()
    channel.addFact('fake-order-4', { id: 'fake-order-4:cancelled', type: 'cancelled', occurredAt: '2026-10-03T08:00:00Z', note: null })
    const next = await pull('5')
    expect(next.items.map((order) => order.externalId)).toEqual(['fake-order-4'])
    expect(next.items[0]?.facts.map((fact) => fact.id)).toEqual(['fake-order-4:cancelled'])
    expect(next).toMatchObject({ nextCursor: '6', hasMore: false })
  })

  it('addFact keeps the facts oldest-first when an older fact arrives later', async () => {
    const channel = createFakeChannel()
    channel.addFact('fake-order-4', { id: 'newer', type: 'cancelled', occurredAt: '2026-10-03T10:00:00Z', note: null })
    channel.addFact('fake-order-4', { id: 'older', type: 'shipped', occurredAt: '2026-10-03T08:00:00Z', note: null })
    const { items } = await channel.connector.capabilities['orders.pull']!(context(), '5')
    expect(items[0]?.facts.map((fact) => fact.id)).toEqual(['older', 'newer'])
  })

  it('addFact throws for an unknown Order', () => {
    const channel = createFakeChannel()
    expect(() => channel.addFact('nope', { id: 'f', type: 'cancelled', occurredAt: '2026-10-03T08:00:00Z', note: null })).toThrow(
      /Unknown Order "nope"/,
    )
  })

  it('addOrder appends to the journal', async () => {
    const { channel, pull } = pullOrders()
    channel.addOrder({ ...structuredClone(seedOrders[0]!), externalId: 'fake-order-9' })
    expect((await pull('5')).items.map((order) => order.externalId)).toEqual(['fake-order-9'])
  })

  it('rejects a malformed cursor as permanent', async () => {
    const { pull } = pullOrders()
    for (const cursor of ['abc', '', '1e0', ' 2 ', '0x2', '2.0', '-1']) {
      await expect(pull(cursor), `cursor "${cursor}"`).rejects.toBeInstanceOf(PermanentError)
    }
  })

  it('does not let callers mutate the Channel through returned Orders', async () => {
    const { pull } = pullOrders()
    ;(await pull(null)).items[0]!.lines.length = 0
    expect((await pull(null)).items[0]!.lines).toHaveLength(1)
  })
})

describe('recorded calls', () => {
  it('records stock.push inputs in order', async () => {
    const channel = createFakeChannel()
    const push = channel.connector.capabilities['stock.push']!
    await push(context(), [{ offerExternalId: 'fake-offer-1', sku: 'FAKE-SKU-1', available: 3 }])
    await push(context(), [])
    expect(channel.stockPushes).toEqual([[{ offerExternalId: 'fake-offer-1', sku: 'FAKE-SKU-1', available: 3 }], []])
  })

  it('records price.push inputs in order and reports the new price on the next offers.pull', async () => {
    const channel = createFakeChannel()
    const push = channel.connector.capabilities['price.push']!
    const price = { offerExternalId: 'fake-offer-1', sku: 'FAKE-SKU-1', price: { amount: '44.00', currency: 'PLN' } }
    await push(context(), [price])
    await push(context(), [])
    expect(channel.pricePushes).toEqual([[price], []])
    const { items } = await channel.connector.capabilities['offers.pull']!(context(), null)
    expect(items[0]?.price).toEqual({ amount: '44.00', currency: 'PLN' })
  })

  it('seeds PLN prices, and no price on fake-offer-5', async () => {
    expect(seedOffers.map((offer) => offer.price?.currency ?? null)).toEqual(['PLN', 'PLN', 'PLN', 'PLN', null])
  })

  it('records orders.updateStatus inputs in order', async () => {
    const channel = createFakeChannel()
    const update = channel.connector.capabilities['orders.updateStatus']!
    await update(context(), { orderExternalId: 'fake-order-1', status: 'processing' })
    await update(context(), { orderExternalId: 'fake-order-1', status: 'shipped' })
    expect(channel.statusUpdates).toEqual([
      { orderExternalId: 'fake-order-1', status: 'processing' },
      { orderExternalId: 'fake-order-1', status: 'shipped' },
    ])
  })

  it('reset restores the seed and clears recorded calls without replacing the arrays', async () => {
    const channel = createFakeChannel()
    const stockPushes = channel.stockPushes
    await channel.connector.capabilities['stock.push']!(context(), [])
    await channel.connector.capabilities['price.push']!(context(), [
      { offerExternalId: 'fake-offer-1', sku: 'FAKE-SKU-1', price: { amount: '1.00', currency: 'PLN' } },
    ])
    await channel.connector.capabilities['orders.updateStatus']!(context(), { orderExternalId: 'x', status: 'new' })
    channel.addOffer({ externalId: 'extra', sku: null, name: 'Extra', url: null })
    channel.addFact('fake-order-1', { id: 'f', type: 'shipped', occurredAt: '2026-10-03T08:00:00Z', note: null })

    channel.reset()

    expect(channel.stockPushes).toBe(stockPushes)
    expect(stockPushes).toEqual([])
    expect(channel.pricePushes).toEqual([])
    expect(channel.statusUpdates).toEqual([])
    expect((await channel.connector.capabilities['offers.pull']!(context(), null)).items[0]?.price).toEqual({ amount: '39.99', currency: 'PLN' })
    const offers = await channel.connector.capabilities['offers.pull']!(context(), '4')
    expect(offers.items.map((offer) => offer.externalId)).toEqual(['fake-offer-5'])
    const last = await channel.connector.capabilities['orders.pull']!(context(), '4')
    expect(last).toMatchObject({ nextCursor: '5', hasMore: false })
    expect(last.items[0]?.facts).toHaveLength(1)
  })

  it('keeps separate instances independent', async () => {
    const a = createFakeChannel()
    const b = createFakeChannel()
    await a.connector.capabilities['stock.push']!(context(), [])
    expect(a.stockPushes).toHaveLength(1)
    expect(b.stockPushes).toHaveLength(0)
  })
})

describe('failure modes', () => {
  const channel = createFakeChannel()
  const { capabilities } = channel.connector
  const calls: Array<[string, (ctx: FakeContext) => Promise<unknown>]> = [
    ['offers.pull', (ctx) => capabilities['offers.pull']!(ctx, null)],
    ['orders.pull', (ctx) => capabilities['orders.pull']!(ctx, null)],
    ['stock.push', (ctx) => capabilities['stock.push']!(ctx, [])],
    ['price.push', (ctx) => capabilities['price.push']!(ctx, [])],
    ['orders.updateStatus', (ctx) => capabilities['orders.updateStatus']!(ctx, { orderExternalId: 'fake-order-1', status: 'shipped' })],
  ]

  it.each(calls)('%s: rate_limited fails with retryAfterMs 1000', async (_name, run) => {
    const error = await run(context({ failMode: 'rate_limited' })).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(RateLimitedError)
    expect(classifyConnectorError(error)).toMatchObject({ kind: 'rate_limited', retryAfterMs: 1000 })
  })

  it.each(calls)('%s: transient fails with TransientError', async (_name, run) => {
    await expect(run(context({ failMode: 'transient' }))).rejects.toBeInstanceOf(TransientError)
  })

  it.each(calls)('%s: permanent fails with PermanentError', async (_name, run) => {
    await expect(run(context({ failMode: 'permanent' }))).rejects.toBeInstanceOf(PermanentError)
  })

  it.each(calls)('%s: apiKey "expired" fails with AuthExpiredError, before failMode', async (_name, run) => {
    await expect(run(context({ failMode: 'permanent' }, 'expired'))).rejects.toBeInstanceOf(AuthExpiredError)
  })

  it('does not record a call that failed', async () => {
    await capabilities['stock.push']!(context({ failMode: 'transient' }), []).catch(() => {})
    await capabilities['price.push']!(context({ failMode: 'transient' }), []).catch(() => {})
    expect(channel.stockPushes).toEqual([])
    expect(channel.pricePushes).toEqual([])
  })

  it('defaults failMode to none and requires an API key', () => {
    expect(fakeConnector.configSchema.parse({})).toEqual({ failMode: 'none' })
    expect(fakeConnector.credentialsSchema.safeParse({ apiKey: '' }).success).toBe(false)
    expect(fakeConnector.configSchema.safeParse({ failMode: 'sometimes' }).success).toBe(false)
  })
})
