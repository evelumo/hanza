import { isCursorExpiredError, isOrderUpdate, PermanentError, type Order, type OrderFeedItem, type OrderUpdate } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { PLUGIN_MISSING_MESSAGE } from '../client'
import { createMedusaConnector } from '../connector'
import { FakeMedusa } from '../testing/fake-medusa'
import { raw, rawItem, rawPayment } from '../testing/samples'
import { decodeCursor } from './orders-cursor'

function pull(store: FakeMedusa, cursor: string | null, options: { pageSize?: number; journalPageSize?: number } = {}) {
  return createMedusaConnector(options).capabilities['orders.pull']!(store.context(), cursor)
}

/** Every page from `cursor` until `hasMore` is false. */
async function pullAll(store: FakeMedusa, cursor: string | null, options: { pageSize?: number; journalPageSize?: number } = {}) {
  const items: OrderFeedItem[] = []
  for (let page = 0; page < 50; page++) {
    const result = await pull(store, cursor, options)
    items.push(...result.items)
    cursor = result.nextCursor
    if (!result.hasMore) return { items, cursor }
  }
  throw new Error('the feed did not end')
}

const fulls = (items: OrderFeedItem[]) => items.filter((item): item is Order => !isOrderUpdate(item))
const updates = (items: OrderFeedItem[]) => items.filter((item): item is OrderUpdate => isOrderUpdate(item))
const describeItems = (items: OrderFeedItem[]) => items.map((item) => `${isOrderUpdate(item) ? 'update' : 'full'} ${item.externalId} [${item.facts.map((fact) => fact.type).join(',')}]`)

describe('orders.pull: the first pull', () => {
  it('takes the journal position first and the boundary second, lists the open orders, then follows the journal', async () => {
    const store = new FakeMedusa()
    const open = store.place({ id: 'order_01A' })
    store.tick(60)
    const unpaid = store.placeUnpaid({ id: 'order_01B' })
    store.tick(60)
    const shipped = store.place({ id: 'order_01C' })
    store.shipAll(shipped)
    store.tick(60)
    const cancelled = store.placeUnpaid({ id: 'order_01D' })
    store.cancelOrder(cancelled)
    store.tick(60)

    const first = await pull(store, null)
    expect(store.urls).toEqual([
      'GET hanza/status',
      'GET orders?order=-created_at&limit=1&fields=id,created_at',
      expect.stringMatching(/^GET orders\?status\[\]=pending&status\[\]=requires_action&created_at\[\$lt\]=2026-10-11T10:03:00\.001Z&order=created_at&limit=100&fields=id,display_id,/),
    ])
    // Open ones in full (the unpaid one awaiting payment), the shipped one as an update, the cancelled one not listed.
    expect(describeItems(first.items)).toEqual(['full order_01A [paid]', 'full order_01B []', 'update order_01C [paid,shipped]'])
    expect(fulls(first.items).find((order) => order.externalId === unpaid)?.awaitingPayment).toBe(true)
    expect(first.hasMore).toBe(true)
    const cursor = decodeCursor(first.nextCursor!)
    expect(cursor).toEqual({ phase: 'journal', position: store.newestSeq, boundary: { time: '2026-10-11T10:03:00.000Z', id: 'order_01D' } })

    // Meanwhile: a new order, the unpaid one paid, and a refund on the order cancelled before the feed started.
    store.tick(60)
    const placed = store.place({ id: 'order_01E' })
    store.capture(unpaid)
    store.update(cancelled, {}, 'payment.refunded')
    store.requests.length = 0
    const second = await pull(store, first.nextCursor)
    expect(store.urls).toEqual([
      'GET hanza/status',
      `GET hanza/journal?after=${cursor.position}&limit=500`,
      expect.stringMatching(/^GET orders\?id\[\]=order_01E&id\[\]=order_01B&id\[\]=order_01D&limit=3&fields=/),
    ])
    // Full Orders only after the boundary, and first on the page.
    expect(describeItems(second.items)).toEqual(['full order_01E [paid]', 'update order_01B [paid]', 'update order_01D [cancelled]'])
    expect(second.hasMore).toBe(false)
    expect(fulls(second.items)[0]!.externalId).toBe(placed)
    expect(open).toBe('order_01A')

    // Caught up: the same cursor again gives nothing more.
    const third = await pull(store, second.nextCursor)
    expect(third).toEqual({ items: [], nextCursor: second.nextCursor, hasMore: false })
  })

  it('lists an order placed between the journal position and the boundary, so it is not lost', async () => {
    const store = new FakeMedusa()
    store.place({ id: 'order_01A' })
    store.beforeAnswer = (count) => {
      // After the status was read: the order's journal entry lies after the position, its creation before the boundary.
      if (count === 2) store.tick(1).place({ id: 'order_01B' })
    }
    const { items } = await pullAll(store, null)
    expect(describeItems(items)).toEqual(['full order_01A [paid]', 'full order_01B [paid]', 'update order_01B [paid]'])
  })

  it('starts at the journal for a store without orders, and sends every later order in full', async () => {
    const store = new FakeMedusa()
    const first = await pull(store, null)
    expect(store.urls).toEqual(['GET hanza/status', 'GET orders?order=-created_at&limit=1&fields=id,created_at', 'GET hanza/journal?after=0&limit=500'])
    expect(first).toEqual({ items: [], nextCursor: 'e1:0::', hasMore: false })
    store.place({ id: 'order_01A' })
    store.tick(60)
    store.placeUnpaid({ id: 'order_01B' })
    const { items } = await pullAll(store, first.nextCursor)
    expect(describeItems(items)).toEqual(['full order_01A [paid]', 'full order_01B []'])
  })

  it('is the same page for the same cursor', async () => {
    const store = new FakeMedusa()
    store.place({ id: 'order_01A' })
    const once = await pull(store, null)
    const twice = await pull(store, null)
    expect(twice).toEqual(once)
  })
})

describe('orders.pull: the listing', () => {
  it('pages by creation time, deals with each order once across a millisecond shared by pages, and loses none when one closes between pages', async () => {
    const store = new FakeMedusa()
    const ids: string[] = []
    for (let index = 0; index < 7; index++) {
      ids.push(store.place({ id: `order_01${String.fromCharCode(65 + index)}` }))
      // Two orders in each millisecond but the last.
      if (index % 2 === 1) store.tick(1)
    }
    store.beforeAnswer = (count) => {
      // While listing, the first order is shipped: the others move up in a list read by offset.
      if (count === 6) store.shipAll(ids[0]!)
    }
    const { items } = await pullAll(store, null, { pageSize: 2 })
    const listed = items.filter((item) => !isOrderUpdate(item) || item.facts.every((fact) => fact.type !== 'shipped')).map((item) => item.externalId)
    expect(new Set(listed)).toEqual(new Set(ids))
    // Each order at most once in full.
    expect(fulls(items).length).toBe(new Set(fulls(items).map((order) => order.externalId)).size)
  })

  it('reads a millisecond shared by more than a page of orders by id, each order once', async () => {
    const store = new FakeMedusa()
    const ids = Array.from({ length: 7 }, (_, index) => store.place({ id: `order_01${String.fromCharCode(65 + index)}` }))
    store.tick(1)
    const last = store.place({ id: 'order_02A' })
    const { items } = await pullAll(store, null, { pageSize: 3 })
    expect(fulls(items).map((order) => order.externalId).sort()).toEqual([...ids, last].sort())
    expect(store.urls.some((url) => url.includes('order=id') && url.includes('created_at[$gte]=2026-10-11T10:00:00.000Z') && url.includes('created_at[$lt]=2026-10-11T10:00:00.001Z'))).toBe(true)
  })

  it('reports a partially shipped order as open, in full', async () => {
    const store = new FakeMedusa()
    const id = store.place({ items: [rawItem('i1'), rawItem('i2', { quantity: 1, raw_quantity: raw('1') })] })
    const fulfillment = store.fulfil(id, [{ id: 'i1', quantity: 2 }], null)
    store.shipFulfillment(id, fulfillment, true)
    expect(store.get(id).fulfillment_status).toBe('partially_shipped')
    const { items } = await pullAll(store, null)
    expect(describeItems(items)).toEqual([`full ${id} [paid]`])
  })

  it('asks only for the sales channels the plugin names, and leaves out orders of others named by the journal', async () => {
    const store = new FakeMedusa()
    store.settings.sales_channel_ids = ['sc_01WEB']
    store.place({ id: 'order_01A' })
    store.place({ id: 'order_01B', sales_channel_id: 'sc_01POS' })
    const first = await pull(store, null)
    expect(store.urls[2]).toContain('sales_channel_id[]=sc_01WEB')
    expect(describeItems(first.items)).toEqual(['full order_01A [paid]'])
    store.tick(60)
    store.place({ id: 'order_01C', sales_channel_id: 'sc_01POS' })
    store.place({ id: 'order_01D' })
    const { items } = await pullAll(store, first.nextCursor)
    expect(describeItems(items)).toEqual(['full order_01D [paid]'])
  })

  it('skips an open order that does not fit the canonical Order and logs ids and paths only; sends a closed one as an update', async () => {
    const store = new FakeMedusa()
    store.place({ id: 'order_01A', shipping_address: null })
    const shipped = store.place({ id: 'order_01B', items: [] })
    store.update(shipped, { fulfillment_status: 'shipped' })
    const { items } = await pullAll(store, null)
    expect(describeItems(items)).toEqual(['update order_01B [paid,shipped]'])
    expect(store.logs).toEqual([{ message: 'Medusa order skipped: it does not fit the canonical Order', fields: { orderId: 'order_01A', fields: ['shippingAddress'] } }])
  })
})

describe('orders.pull: the journal', () => {
  /** A store whose feed has listed what it had and stands at the journal. */
  async function atJournal(prepare: (store: FakeMedusa) => void = () => {}) {
    const store = new FakeMedusa()
    prepare(store)
    const { cursor } = await pullAll(store, null)
    store.requests.length = 0
    store.logs.length = 0
    store.tick(60)
    return { store, cursor }
  }

  it('reports an unpaid order in full, then its payment as an update with the paid fact', async () => {
    const { store, cursor } = await atJournal()
    const id = store.placeUnpaid()
    const first = await pullAll(store, cursor)
    expect(first.items).toMatchObject([{ externalId: id, awaitingPayment: true, facts: [] }])
    store.tick(60).capture(id)
    const second = await pullAll(store, first.cursor)
    // Placed after the boundary: in full again, with the fact; never awaiting payment once paid.
    expect(second.items).toMatchObject([{ externalId: id, facts: [{ id: `${id}:paid`, type: 'paid', occurredAt: store.now }] }])
    expect((second.items[0] as Order).awaitingPayment).toBeUndefined()
  })

  it('reports a cash-on-delivery order as ready to fulfil, without a paid fact', async () => {
    const { store, cursor } = await atJournal((s) => {
      s.settings.pay_on_delivery_provider_ids = ['pp_cod']
    })
    const id = store.place({ payment_status: 'authorized', payment_collections: [{ payments: [rawPayment('pay_1', { provider_id: 'pp_cod' })] }] })
    const { items } = await pullAll(store, cursor)
    expect(items).toMatchObject([{ externalId: id, payment: 'cash_on_delivery', facts: [] }])
    expect((items[0] as Order).awaitingPayment).toBeUndefined()
  })

  it('reports a cancelled order with its cancelled fact', async () => {
    const { store, cursor } = await atJournal((s) => s.placeUnpaid({ id: 'order_01A' }))
    store.cancelOrder('order_01A')
    const late = store.placeUnpaid({ id: 'order_01B' })
    store.cancelOrder(late)
    const { items } = await pullAll(store, cursor)
    // Before the boundary as an update, after it in full (with every fact it has).
    expect(describeItems(items)).toEqual(['full order_01B [cancelled]', 'update order_01A [cancelled]'])
  })

  it('reads each order a page names once, in batches of the page size, and leaves out drafts and orders Medusa does not list', async () => {
    const { store, cursor } = await atJournal()
    const ids = ['order_01A', 'order_01B', 'order_01C'].map((id) => store.place({ id }))
    store.update(ids[0]!, {})
    store.place({ id: 'order_01D', is_draft_order: true })
    const gone = store.place({ id: 'order_01E' })
    store.remove(gone)
    const result = await pull(store, cursor, { pageSize: 2 })
    expect(store.urls.filter((url) => url.startsWith('GET orders?id'))).toEqual([
      expect.stringMatching(/^GET orders\?id\[\]=order_01A&id\[\]=order_01B&limit=2&/),
      expect.stringMatching(/^GET orders\?id\[\]=order_01C&id\[\]=order_01D&limit=2&/),
      expect.stringMatching(/^GET orders\?id\[\]=order_01E&limit=1&/),
    ])
    expect(result.items.map((item) => item.externalId)).toEqual(ids)
    // Medusa's order list leaves drafts out (to verify in the sandbox); the connector would drop one it sent anyway.
    expect(store.logs).toEqual([
      { message: 'Medusa order named by the journal was not found; left out', fields: { orderId: 'order_01D' } },
      { message: 'Medusa order named by the journal was not found; left out', fields: { orderId: gone } },
    ])
  })

  it('has more while a page is full, and moves its position to the last entry', async () => {
    const { store, cursor } = await atJournal()
    for (let index = 0; index < 5; index++) store.place()
    const first = await pull(store, cursor, { journalPageSize: 2 })
    expect(first.hasMore).toBe(true)
    expect(decodeCursor(first.nextCursor!)).toMatchObject({ phase: 'journal', position: decodeCursor(cursor!).position + 2 })
    const { items } = await pullAll(store, cursor, { journalPageSize: 2 })
    expect(items).toHaveLength(5)
  })

  it('throws CursorExpiredError when the plugin no longer keeps the position', async () => {
    const store = new FakeMedusa().startJournalAt(20)
    store.prunedThroughSeq = 10
    const failure = await pull(store, 'e1:3::').catch((error: unknown) => error)
    expect(isCursorExpiredError(failure)).toBe(true)
  })
})

describe('orders.pull: the plugin', () => {
  it('says the plugin is missing', async () => {
    const store = new FakeMedusa()
    store.pluginInstalled = false
    await expect(pull(store, null)).rejects.toThrow(PLUGIN_MISSING_MESSAGE)
    await expect(pull(store, 'e1:0::')).rejects.toThrow(PLUGIN_MISSING_MESSAGE)
  })

  it('refuses a wire format it does not know', async () => {
    const store = new FakeMedusa()
    store.format = 2
    store.pluginVersion = '2.0.0'
    await expect(pull(store, null)).rejects.toThrow('medusa-plugin-hanza "2.0.0" speaks wire format 2; this Hanza understands format 1')
  })

  it('refuses a cursor it cannot read before asking anything', async () => {
    const store = new FakeMedusa()
    await expect(pull(store, 'x1:whatever')).rejects.toBeInstanceOf(PermanentError)
    expect(store.requests).toEqual([])
  })
})
