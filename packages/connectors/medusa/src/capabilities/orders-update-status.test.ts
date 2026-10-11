import { PermanentError } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { medusaConnector } from '../connector'
import { FakeMedusa } from '../testing/fake-medusa'
import { raw, rawItem } from '../testing/samples'

const update = (store: FakeMedusa, orderExternalId: string, phase: 'new' | 'processing' | 'shipped' | 'cancelled') =>
  medusaConnector.capabilities['orders.updateStatus']!(store.context(), { orderExternalId, phase })

function twoLines(store: FakeMedusa): string {
  return store.place({ id: 'order_01A', items: [rawItem('item_1'), rawItem('item_2', { quantity: 1, raw_quantity: raw('1') })] })
}

describe('orders.updateStatus', () => {
  it.each(['new', 'processing'] as const)('changes nothing for %s, without a request', async (phase) => {
    const store = new FakeMedusa()
    const id = twoLines(store)
    await update(store, id, phase)
    expect(store.requests).toEqual([])
  })

  it('ships an order without a fulfillment: one fulfillment of every item from the plugin\'s location, then its shipment', async () => {
    const store = new FakeMedusa()
    const id = twoLines(store)
    await update(store, id, 'shipped')
    expect(store.writes).toEqual([
      { path: `orders/${id}/fulfillments`, body: { items: [{ id: 'item_1', quantity: 2 }, { id: 'item_2', quantity: 1 }], location_id: 'sloc_01MAIN' } },
      {
        path: `orders/${id}/fulfillments/ful_${id}_1/shipments`,
        body: { items: [{ id: 'item_1', quantity: 2 }, { id: 'item_2', quantity: 1 }], no_notification: false },
      },
    ])
    expect(store.get(id).fulfillment_status).toBe('shipped')
    // Repeated: read, already shipped, nothing sent.
    store.requests.length = 0
    await update(store, id, 'shipped')
    expect(store.urls).toEqual([expect.stringMatching(new RegExp(`^GET orders/${id}\\?fields=`))])
  })

  it('ships an order with an existing fulfillment: fulfils only what it does not cover, and ships each fulfillment not shipped', async () => {
    const store = new FakeMedusa()
    const id = twoLines(store)
    store.fulfil(id, [{ id: 'item_1', quantity: 2 }], 'sloc_01MAIN')
    store.settings.notify_customer_on_shipment = false
    await update(store, id, 'shipped')
    expect(store.writes).toEqual([
      { path: `orders/${id}/fulfillments`, body: { items: [{ id: 'item_2', quantity: 1 }], location_id: 'sloc_01MAIN' } },
      { path: `orders/${id}/fulfillments/ful_${id}_1/shipments`, body: { items: [{ id: 'item_1', quantity: 2 }], no_notification: true } },
      { path: `orders/${id}/fulfillments/ful_${id}_2/shipments`, body: { items: [{ id: 'item_2', quantity: 1 }], no_notification: true } },
    ])
    expect(store.shipmentNotifications).toEqual([true, true])
  })

  it('ships the fulfillment a person already made, without making another', async () => {
    const store = new FakeMedusa()
    const id = twoLines(store)
    store.fulfil(id, [{ id: 'item_1', quantity: 2 }, { id: 'item_2', quantity: 1 }], 'sloc_01MAIN')
    await update(store, id, 'shipped')
    expect(store.writes.map((write) => write.path)).toEqual([`orders/${id}/fulfillments/ful_${id}_1/shipments`])
  })

  it('leaves out the location when the plugin has none, so Medusa takes the shipping option\'s', async () => {
    const store = new FakeMedusa()
    const id = twoLines(store)
    store.settings.stock_location_id = null
    await update(store, id, 'shipped')
    expect(store.writes[0]!.body).toEqual({ items: [{ id: 'item_1', quantity: 2 }, { id: 'item_2', quantity: 1 }] })
  })

  it('does not ship a cancelled order', async () => {
    const store = new FakeMedusa()
    const id = store.placeUnpaid()
    store.cancelOrder(id)
    await update(store, id, 'shipped')
    expect(store.writes).toEqual([])
    expect(store.logs).toEqual([{ message: 'Medusa order is cancelled; not shipped', fields: { orderId: id } }])
  })

  it('cancels an order with no money taken and no fulfillment, once', async () => {
    const store = new FakeMedusa()
    const id = store.placeUnpaid()
    await update(store, id, 'cancelled')
    expect(store.writes).toEqual([{ path: `orders/${id}/cancel`, body: undefined }])
    expect(store.get(id).status).toBe('canceled')
    await update(store, id, 'cancelled')
    expect(store.writes).toHaveLength(1)
  })

  it('does not cancel a captured order: no call, and it says why in the log', async () => {
    const store = new FakeMedusa()
    const id = store.place()
    await update(store, id, 'cancelled')
    expect(store.writes).toEqual([])
    expect(store.logs).toEqual([{ message: 'Medusa order not cancelled: it has a captured payment or a fulfillment; cancel it in Medusa', fields: { orderId: id } }])
  })

  it('does not cancel an order with a live fulfillment', async () => {
    const store = new FakeMedusa()
    const id = store.placeUnpaid()
    store.fulfil(id, [{ id: `${id}_item_1`, quantity: 2 }], null)
    await update(store, id, 'cancelled')
    expect(store.writes.filter((write) => write.path.endsWith('/cancel'))).toEqual([])
  })

  it('fails permanently for an order Medusa does not have', async () => {
    const store = new FakeMedusa()
    await expect(update(store, 'order_missing', 'shipped')).rejects.toBeInstanceOf(PermanentError)
  })
})
