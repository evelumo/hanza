import {
  AuthExpiredError,
  CursorExpiredError,
  PermanentError,
  RateLimitedError,
  TransientError,
  classifyConnectorError,
  isOrderUpdate,
  listCapabilities,
  offerSchema,
  orderSchema,
  type CapabilityContext,
  type Order,
  type OrderUpdate,
  type PullResult,
} from '@hanza/connector-sdk'
import { assertConformance } from '@hanza/connector-sdk/testing'
import { describe, expect, it } from 'vitest'
import { FAKE_API_URL, createFakeChannel, fakeChannel, fakeConnector, FAKE_OFFER_ENDED_CODE, FAKE_REJECTED_CODE } from './index'
import { seedFacts, seedOffers, seedOrders } from './seed'

type FakeContext = CapabilityContext<{ failMode: 'none' | 'rate_limited' | 'transient' | 'permanent'; rejectOffers: string }, { apiKey: string }>

const context = (overrides: Partial<FakeContext['config']> = {}, apiKey = 'test'): FakeContext => ({
  app: {},
  config: { failMode: 'none', rejectOffers: '', ...overrides },
  credentials: { apiKey },
  fetch: async () => {
    throw new Error('the fake connector never uses the network')
  },
  log: () => {},
})

/** A page that must hold full Orders only (the replay mode never returns an update unless a test adds one). */
function fullOrders(page: PullResult<Order | OrderUpdate>): PullResult<Order> {
  return {
    ...page,
    items: page.items.map((item) => {
      if (isOrderUpdate(item)) throw new Error(`unexpected Order update for "${item.externalId}"`)
      return item
    }),
  }
}

function pullOrders(channel = createFakeChannel()) {
  const pull = channel.connector.capabilities['orders.pull']!
  return { channel, pull: async (cursor: string | null) => fullOrders(await pull(context(), cursor)) }
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

  it('can run under another id, with its own state', async () => {
    const shop = createFakeChannel({ id: 'fake-shop' })
    const other = createFakeChannel()
    expect(shop.connector.id).toBe('fake-shop')
    await shop.connector.capabilities['stock.push']!(context(), [{ offerExternalId: 'fake-offer-1', sku: 'FAKE-SKU-1', available: 2 }])
    expect(shop.stockPushes).toHaveLength(1)
    expect(other.stockPushes).toEqual([])
  })

  it('has a seed that satisfies the canonical schemas', () => {
    seedOffers.forEach((offer) => expect(offerSchema.parse(offer)).toEqual(offer))
    seedOrders.forEach((order) => expect(orderSchema.parse(order)).toEqual(order))
    seedFacts.forEach(({ fact }) => expect(fact.id).toBe('fake-order-2:cancelled'))
  })
})

describe('per-Offer results and publication', () => {
  const level = (offerExternalId: string, available: number) => ({ offerExternalId, sku: null, available })

  it('ends an active Offer at 0, reopens it above 0 because it sold out, and reports it on the next pull', async () => {
    const channel = createFakeChannel()
    const push = channel.connector.capabilities['stock.push']!
    expect(await push(context(), [level('fake-offer-1', 0), level('fake-offer-2', 4)])).toEqual([
      { offerExternalId: 'fake-offer-1', outcome: 'ended' },
    ])
    expect(channel.offer('fake-offer-1', 'test')).toMatchObject({ status: 'ended', endedReason: 'sold_out' })
    const pulled = await channel.connector.capabilities['offers.pull']!(context(), null)
    expect(pulled.items[0]).toMatchObject({ externalId: 'fake-offer-1', status: 'ended', endedReason: 'sold_out' })

    // A 0 that leaves it sold out says so again (a retry after a lost answer must learn it); above 0 reopens it.
    expect(await push(context(), [level('fake-offer-1', 0)])).toEqual([{ offerExternalId: 'fake-offer-1', outcome: 'ended' }])
    expect(await push(context(), [level('fake-offer-1', 2)])).toEqual([])
    expect(channel.offer('fake-offer-1', 'test')).toMatchObject({ status: 'active' })
    expect(channel.offer('fake-offer-1', 'test')).not.toHaveProperty('endedReason')
    expect(channel.connector.reopensSoldOutOffers).toBe(true)
  })

  it('keeps what pushes did to Offers per account, so one Connection never ends another one\'s Offer', async () => {
    const channel = createFakeChannel()
    const push = channel.connector.capabilities['stock.push']!
    const pull = channel.connector.capabilities['offers.pull']!
    await push(context({}, 'seller-a'), [level('fake-offer-1', 0)])

    expect((await pull(context({}, 'seller-a'), null)).items[0]).toMatchObject({ status: 'ended', endedReason: 'sold_out' })
    expect((await pull(context({}, 'seller-b'), null)).items[0]).toMatchObject({ status: 'active' })
    expect((await pull(context({}, 'seller-b'), null)).items[0]).not.toHaveProperty('endedReason')
    expect(channel.offer('fake-offer-1')).toMatchObject({ status: 'active' })
    // seller-b's 4 does not reopen anything of seller-a's, and seller-a's Offer stays ended.
    expect(await push(context({}, 'seller-b'), [level('fake-offer-1', 4)])).toEqual([])
    expect(channel.offer('fake-offer-1', 'seller-a')).toMatchObject({ status: 'ended' })

    // Replacing the Offer in the catalogue sets it for everyone; reset forgets every account.
    channel.addOffer({ ...channel.offer('fake-offer-1')!, status: 'inactive' })
    expect(channel.offer('fake-offer-1', 'seller-a')).toMatchObject({ status: 'inactive' })
    await push(context({}, 'seller-b'), [level('fake-offer-2', 0)])
    channel.reset()
    expect(channel.offer('fake-offer-2', 'seller-b')).toMatchObject({ status: 'active' })
  })

  it('refuses a number above 0 for an Offer ended for another reason', async () => {
    const channel = createFakeChannel()
    channel.addOffer({ externalId: 'ended-by-seller', sku: null, name: 'Ended', url: null, status: 'ended', endedReason: 'other' })
    expect(await channel.connector.capabilities['stock.push']!(context(), [level('ended-by-seller', 3)])).toEqual([
      { offerExternalId: 'ended-by-seller', outcome: 'rejected', code: FAKE_OFFER_ENDED_CODE },
    ])
    expect(channel.offer('ended-by-seller', 'test')).toMatchObject({ status: 'ended', endedReason: 'other' })
    // A 0 to it changes nothing and reports nothing: it did not end because it sold out.
    expect(await channel.connector.capabilities['stock.push']!(context(), [level('ended-by-seller', 0)])).toEqual([])
  })

  it('rejects the stock and price of configured Offers and keeps the others', async () => {
    const channel = createFakeChannel()
    channel.reject('fake-offer-2', 'PRICE_TOO_LOW')
    const ctx = context({ rejectOffers: ' fake-offer-3 , other' })
    expect(await channel.connector.capabilities['stock.push']!(ctx, [level('fake-offer-1', 1), level('fake-offer-2', 1), level('fake-offer-3', 1)])).toEqual([
      { offerExternalId: 'fake-offer-2', outcome: 'rejected', code: 'PRICE_TOO_LOW' },
      { offerExternalId: 'fake-offer-3', outcome: 'rejected', code: FAKE_REJECTED_CODE },
    ])
    const price = (offerExternalId: string) => ({ offerExternalId, sku: null, price: { amount: '9.99', currency: 'PLN' } })
    expect(await channel.connector.capabilities['price.push']!(ctx, [price('fake-offer-1'), price('fake-offer-3')])).toEqual([
      { offerExternalId: 'fake-offer-3', outcome: 'rejected', code: FAKE_REJECTED_CODE },
    ])
    expect(channel.offer('fake-offer-1')?.price).toEqual({ amount: '9.99', currency: 'PLN' })
    expect(channel.offer('fake-offer-3')?.price).toEqual({ amount: '25.00', currency: 'PLN' })

    channel.reject('fake-offer-2', null)
    expect(await channel.connector.capabilities['stock.push']!(context(), [level('fake-offer-2', 1)])).toEqual([])
    channel.reject('fake-offer-2', 'X')
    channel.reset()
    expect(await channel.connector.capabilities['stock.push']!(context(), [level('fake-offer-2', 1)])).toEqual([])
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
    const { items } = fullOrders(await channel.connector.capabilities['orders.pull']!(context(), '5'))
    expect(items[0]?.facts.map((fact) => fact.id)).toEqual(['older', 'newer'])
  })

  it('a paid fact clears awaitingPayment, so the Order it returns again is ready and still valid', async () => {
    const { channel, pull } = pullOrders()
    channel.addOrder({ ...structuredClone(seedOrders[0]!), externalId: 'fake-order-unpaid', awaitingPayment: true })
    expect((await pull('5')).items[0]).toMatchObject({ externalId: 'fake-order-unpaid', awaitingPayment: true })

    channel.addFact('fake-order-unpaid', { id: 'fake-order-unpaid:paid', type: 'paid', occurredAt: '2026-10-03T08:00:00Z', note: null })
    const [again] = (await pull('6')).items
    expect(again).toMatchObject({ externalId: 'fake-order-unpaid', awaitingPayment: false })
    expect(orderSchema.safeParse(again).success).toBe(true)
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

describe('Order updates, removed Orders and a forgotten journal', () => {
  const newAddress = { ...seedOrders[0]!.shippingAddress, street: '9 New Street' }

  it('updateOrder changes the Order and appends exactly the change as an Order update', async () => {
    const channel = createFakeChannel()
    const pull = channel.connector.capabilities['orders.pull']!
    channel.addOrder({ ...structuredClone(seedOrders[0]!), externalId: 'unpaid', awaitingPayment: true })
    const paid = { id: 'unpaid:paid', type: 'paid' as const, occurredAt: '2026-10-03T08:00:00Z', note: null }
    channel.updateOrder('unpaid', { facts: [paid], shippingAddress: newAddress })

    const page = await pull(context(), '6')
    expect(page.items).toEqual([{ kind: 'update', externalId: 'unpaid', facts: [paid], shippingAddress: newAddress }])
    expect(page).toMatchObject({ nextCursor: '7', hasMore: false })
    // The earlier entry now shows the Order as it is: paid, with the new address.
    const [order] = (await pull(context(), '5')).items
    expect(order).toMatchObject({ awaitingPayment: false, shippingAddress: newAddress, facts: [paid] })
    expect(() => channel.updateOrder('nope', {})).toThrow(/Unknown Order "nope"/)
  })

  it('removeOrder deletes the Order: each of its entries is pulled as the removal update', async () => {
    const channel = createFakeChannel()
    const pull = channel.connector.capabilities['orders.pull']!
    const removed = { id: 'fake-order-1:removed', type: 'cancelled' as const, occurredAt: '2026-10-03T08:00:00Z', note: 'Merged' }
    channel.removeOrder('fake-order-1', removed)
    const update = { kind: 'update', externalId: 'fake-order-1', facts: [removed] }
    expect((await pull(context(), null)).items[0]).toEqual(update)
    expect((await pull(context(), '5')).items).toEqual([update])
    expect(() => channel.addFact('fake-order-1', removed)).toThrow(/Unknown Order/)
  })

  it('forgetJournal expires older cursors; the newest position and null still work', async () => {
    const channel = createFakeChannel()
    const pull = channel.connector.capabilities['orders.pull']!
    channel.forgetJournal()
    await expect(pull(context(), '4')).rejects.toBeInstanceOf(CursorExpiredError)
    expect(await pull(context(), '5')).toEqual({ items: [], nextCursor: '5', hasMore: false })
    expect(await pull(context(), null)).toEqual({ items: [], nextCursor: null, hasMore: false })
    channel.addOrder({ ...structuredClone(seedOrders[0]!), externalId: 'later' })
    expect(fullOrders(await pull(context(), '5')).items.map((order) => order.externalId)).toEqual(['later'])
  })
})

describe('orders.pull starting with the open Orders (startWithOpenOrders)', () => {
  const journalChannel = () => createFakeChannel({ startWithOpenOrders: true })
  const shipped = (id: string) => ({ id: `${id}:shipped`, type: 'shipped' as const, occurredAt: '2026-10-03T08:00:00Z', note: null })
  const ids = (items: Array<{ externalId: string }>) => items.map((item) => item.externalId)

  it('passes the conformance kit as a journal, with an expired cursor', async () => {
    const channel = journalChannel()
    // Changes before the run are before its start: the run from null lists the open Orders and finds an empty journal.
    channel.removeOrder('fake-order-3', { id: 'fake-order-3:removed', type: 'cancelled', occurredAt: '2026-10-03T09:00:00Z', note: null })
    channel.forgetJournal()
    await assertConformance(channel.connector, {
      config: { failMode: 'none' },
      credentials: { apiKey: 'test' },
      unauthorized: { credentials: { apiKey: 'expired' } },
      journal: true,
      expiredCursor: 'e:5:5',
    })
  })

  it('lists the open seed Orders (not the cancelled fake-order-2), then follows the journal from before the listing', async () => {
    const channel = journalChannel()
    const pull = channel.connector.capabilities['orders.pull']!
    const first = await pull(context(), null)
    expect(ids(first.items)).toEqual(['fake-order-1', 'fake-order-3'])
    expect(first).toMatchObject({ nextCursor: 'l:5:3', hasMore: true })

    // Placed while the listing runs: not listed (the journal had it only after position 5), but in the journal.
    channel.addOrder({ ...structuredClone(seedOrders[0]!), externalId: 'during-listing' })
    const second = await pull(context(), 'l:5:3')
    expect(ids(second.items)).toEqual(['fake-order-4'])
    expect(second).toMatchObject({ nextCursor: 'e:5:5', hasMore: true })

    const journal = await pull(context(), 'e:5:5')
    expect(journal.items.map((item) => [item.externalId, isOrderUpdate(item)])).toEqual([['during-listing', false]])
    expect(journal).toMatchObject({ nextCursor: 'e:5:6', hasMore: false })
    expect(await pull(context(), 'e:5:6')).toEqual({ items: [], nextCursor: 'e:5:6', hasMore: false })
  })

  it('pages the listing by keyset: an Order closing between two pages makes no other Order skipped', async () => {
    const channel = journalChannel()
    const pull = channel.connector.capabilities['orders.pull']!
    const first = await pull(context(), null)
    expect(ids(first.items)).toEqual(['fake-order-1', 'fake-order-3'])
    // With offsets, fake-order-4 would now sit at offset 1 and never be listed.
    channel.addFact('fake-order-1', shipped('fake-order-1'))
    const second = await pull(context(), first.nextCursor)
    expect(ids(second.items)).toEqual(['fake-order-4'])
  })

  it('sends an Order the Channel had before the feed started only as an Order update in the journal, with every fact', async () => {
    const channel = journalChannel()
    const pull = channel.connector.capabilities['orders.pull']!
    await pull(context(), null)
    // A change on fake-order-2, cancelled before the Connection: a full Order would be imported with its facts.
    channel.addFact('fake-order-2', shipped('fake-order-2'))
    channel.addFact('fake-order-1', shipped('fake-order-1'))
    const page = await pull(context(), 'e:5:5')
    expect(page.items).toEqual([
      { kind: 'update', externalId: 'fake-order-2', facts: [expect.objectContaining({ type: 'cancelled' }), shipped('fake-order-2')] },
      { kind: 'update', externalId: 'fake-order-1', facts: [shipped('fake-order-1')] },
    ])
    // An Order placed after the start stays whole, also on its later entries.
    channel.addOrder({ ...structuredClone(seedOrders[0]!), externalId: 'later' })
    channel.addFact('later', shipped('later'))
    expect((await pull(context(), 'e:5:7')).items.map((item) => [item.externalId, isOrderUpdate(item)])).toEqual([
      ['later', false],
      ['later', false],
    ])
  })

  it('ends the listing with hasMore false when the journal has nothing after its position', async () => {
    const channel = journalChannel()
    channel.addFact('fake-order-1', shipped('fake-order-1'))
    const pull = channel.connector.capabilities['orders.pull']!
    expect(await pull(context(), 'l:6:3')).toMatchObject({ nextCursor: 'e:6:6', hasMore: false })
    expect(ids((await pull(context(), 'l:6:3')).items)).toEqual(['fake-order-4'])
  })

  it('expires listing and journal cursors older than the forgotten journal, and rejects malformed ones as permanent', async () => {
    const channel = journalChannel()
    const pull = channel.connector.capabilities['orders.pull']!
    channel.forgetJournal()
    await expect(pull(context(), 'e:4:4')).rejects.toBeInstanceOf(CursorExpiredError)
    await expect(pull(context(), 'l:4:0')).rejects.toBeInstanceOf(CursorExpiredError)
    expect(await pull(context(), 'e:4:5')).toEqual({ items: [], nextCursor: 'e:4:5', hasMore: false })
    expect((await pull(context(), null)).nextCursor).toBe('l:5:3')
    for (const cursor of ['5', 'e:5', 'e:', 'l:5', 'x:1', 'e:6:5']) {
      await expect(pull(context(), cursor), `cursor "${cursor}"`).rejects.toBeInstanceOf(PermanentError)
      await expect(pull(context(), cursor)).rejects.not.toBeInstanceOf(CursorExpiredError)
    }
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
    await update(context(), { orderExternalId: 'fake-order-1', phase: 'processing' })
    await update(context(), { orderExternalId: 'fake-order-1', phase: 'shipped' })
    expect(channel.statusUpdates).toEqual([
      { orderExternalId: 'fake-order-1', phase: 'processing' },
      { orderExternalId: 'fake-order-1', phase: 'shipped' },
    ])
  })

  it('reset restores the seed and clears recorded calls without replacing the arrays', async () => {
    const channel = createFakeChannel()
    const stockPushes = channel.stockPushes
    await channel.connector.capabilities['stock.push']!(context(), [])
    await channel.connector.capabilities['price.push']!(context(), [
      { offerExternalId: 'fake-offer-1', sku: 'FAKE-SKU-1', price: { amount: '1.00', currency: 'PLN' } },
    ])
    await channel.connector.capabilities['orders.updateStatus']!(context(), { orderExternalId: 'x', phase: 'new' })
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
    const last = fullOrders(await channel.connector.capabilities['orders.pull']!(context(), '4'))
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
    ['orders.updateStatus', (ctx) => capabilities['orders.updateStatus']!(ctx, { orderExternalId: 'fake-order-1', phase: 'shipped' })],
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
    expect(fakeConnector.configSchema.parse({})).toEqual({ failMode: 'none', rejectOffers: '' })
    expect(fakeConnector.credentialsSchema.safeParse({ apiKey: '' }).success).toBe(false)
    expect(fakeConnector.configSchema.safeParse({ failMode: 'sometimes' }).success).toBe(false)
  })
})

describe('HTTP mode', () => {
  const httpContext = (fetch: typeof globalThis.fetch, apiKey = 'test'): FakeContext => ({ ...context({}, apiKey), fetch })

  it('passes the conformance kit, including C14 (a 403 is not an expired sign-in)', async () => {
    const channel = createFakeChannel({ http: true })
    await assertConformance(channel.connector, {
      config: { failMode: 'none' },
      credentials: { apiKey: 'test' },
      fetch: channel.api.fetch,
      unauthorized: { credentials: { apiKey: 'expired' } },
    })
    expect(channel.api.requests.length).toBeGreaterThan(0)
  })

  it('sends one authenticated request per call and records it', async () => {
    const channel = createFakeChannel({ http: true })
    await channel.connector.capabilities['stock.push']!(httpContext(channel.api.fetch, 'key-a'), [])
    expect(channel.api.requests).toEqual([{ at: expect.any(Number), operation: 'stock.push', apiKey: 'key-a' }])
    expect(channel.stockPushes).toEqual([[]])
  })

  it('maps 401 to AuthExpiredError, a bare 403 to PermanentError and 429 to RateLimitedError with its Retry-After', async () => {
    const channel = createFakeChannel({ http: true })
    const push = () => channel.connector.capabilities['stock.push']!(httpContext(channel.api.fetch), [])
    channel.api.failNext(401)
    await expect(push()).rejects.toBeInstanceOf(AuthExpiredError)
    channel.api.failNext(403)
    const forbidden = await push().catch((error: unknown) => error)
    expect(classifyConnectorError(forbidden)).toEqual({ kind: 'permanent', retryAfterMs: null, message: '403 Forbidden' })
    channel.api.failNext(403, { headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' } })
    await expect(push()).rejects.toBeInstanceOf(AuthExpiredError)
    channel.api.failNext(429, { headers: { 'Retry-After': '2' } })
    expect(classifyConnectorError(await push().catch((error: unknown) => error))).toMatchObject({ kind: 'rate_limited', retryAfterMs: 2000 })
    expect(channel.stockPushes).toEqual([])
  })

  it('lets a ConnectorError from ctx.fetch through and maps a network failure to TransientError', async () => {
    const channel = createFakeChannel({ http: true })
    const limited = new RateLimitedError('budget used up', { retryAfterMs: 500 })
    const pull = (fetch: typeof globalThis.fetch) => channel.connector.capabilities['orders.pull']!(httpContext(fetch), null)
    await expect(pull(async () => { throw limited })).rejects.toBe(limited)
    await expect(pull(async () => { throw new TypeError('fetch failed') })).rejects.toBeInstanceOf(TransientError)
  })

  it('answers only its own URL', async () => {
    const { api } = createFakeChannel({ http: true })
    await expect(api.fetch('https://example.com/x')).rejects.toThrow(/does not serve/)
    expect((await api.fetch(`${FAKE_API_URL}/offers.pull`)).status).toBe(204)
  })

  it('declares the rate limits it is given', () => {
    const rateLimits = { application: { requests: 5, windowMs: 1000 }, connection: { concurrency: 1 } }
    expect(createFakeChannel({ rateLimits }).connector.rateLimits).toEqual(rateLimits)
    expect(createFakeChannel().connector.rateLimits).toBeUndefined()
  })
})
