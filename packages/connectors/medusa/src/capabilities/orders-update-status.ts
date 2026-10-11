import type { OrderPhase } from '@hanza/connector-sdk'
import { z } from 'zod'
import { ORDER_STATE_FIELDS, singleOrderStateSchema, type MedusaOrderState } from '../api'
import { request } from '../client'
import { wholeNumberOf } from '../mapping/amount'
import { actionForPhase, CANCELED_ORDER_STATUS, paymentsOf, PAID_PAYMENT_STATUSES, SHIPPED_FULFILLMENT_STATUSES } from '../mapping/status'
import { readStatus } from '../plugin'
import type { MedusaContext } from '../settings'

/** `payment_status` values that mean some money was taken: Medusa refuses to cancel such an order, and a refund is a person's decision. */
const CAPTURED_PAYMENT_STATUSES: readonly string[] = [...PAID_PAYMENT_STATUSES, 'partially_captured']

const quantity = (value: number | string) => wholeNumberOf(null, value) ?? 0

async function readOrder(ctx: MedusaContext, id: string): Promise<MedusaOrderState> {
  const { order } = await request(ctx, {
    path: `orders/${encodeURIComponent(id)}`,
    query: [['fields', ORDER_STATE_FIELDS]],
    schema: singleOrderStateSchema,
    what: 'order',
  })
  return order
}

const liveFulfillments = (order: MedusaOrderState) => (order.fulfillments ?? []).filter((fulfillment) => !fulfillment.canceled_at)

/** Each item's quantity no live fulfillment covers yet. */
export function unfulfilledItems(order: MedusaOrderState): Array<{ id: string; quantity: number }> {
  const fulfilled = new Map<string, number>()
  for (const fulfillment of liveFulfillments(order)) {
    for (const item of fulfillment.items ?? []) {
      if (!item.line_item_id) continue
      fulfilled.set(item.line_item_id, (fulfilled.get(item.line_item_id) ?? 0) + quantity(item.quantity))
    }
  }
  return (order.items ?? [])
    .map((item) => ({ id: item.id, quantity: (wholeNumberOf(item.raw_quantity, item.quantity) ?? 0) - (fulfilled.get(item.id) ?? 0) }))
    .filter((item) => item.quantity > 0)
}

/** Whether any money was taken for the order. */
export function hasCapturedPayment(order: MedusaOrderState): boolean {
  return CAPTURED_PAYMENT_STATUSES.includes(order.payment_status ?? '') || paymentsOf(order).some((payment) => payment.captured_at)
}

/**
 * `shipped`: a fulfillment of every item no live fulfillment covers (from the plugin's stock location), then a shipment
 * for every live fulfillment not shipped yet, e-mailing the Buyer as the plugin's settings say. Each step reads first
 * and skips what is done, so a repeat sends nothing more.
 */
async function ship(ctx: MedusaContext, orderId: string): Promise<void> {
  let order = await readOrder(ctx, orderId)
  if (order.status === CANCELED_ORDER_STATUS) {
    ctx.log('Medusa order is cancelled; not shipped', { orderId })
    return
  }
  if (SHIPPED_FULFILLMENT_STATUSES.includes(order.fulfillment_status ?? '')) return
  const { settings } = await readStatus(ctx)
  const missing = unfulfilledItems(order)
  if (missing.length > 0) {
    await request(ctx, {
      method: 'POST',
      path: `orders/${encodeURIComponent(orderId)}/fulfillments`,
      // Without a location Medusa takes the one of the order's shipping option.
      body: { items: missing, ...(settings.stock_location_id === null ? {} : { location_id: settings.stock_location_id }) },
      schema: z.unknown(),
      what: 'fulfillment',
    })
    order = await readOrder(ctx, orderId)
  }
  for (const fulfillment of liveFulfillments(order)) {
    if (fulfillment.shipped_at) continue
    const items = (fulfillment.items ?? []).flatMap((item) => (item.line_item_id ? [{ id: item.line_item_id, quantity: quantity(item.quantity) }] : []))
    await request(ctx, {
      method: 'POST',
      path: `orders/${encodeURIComponent(orderId)}/fulfillments/${encodeURIComponent(fulfillment.id)}/shipments`,
      body: { items, no_notification: !settings.notify_customer_on_shipment },
      schema: z.unknown(),
      what: 'shipment',
    })
  }
}

/**
 * `cancelled`: cancels an order Medusa still lets go without a person: no money taken and no live fulfillment.
 * Otherwise the call resolves and says why in the log: a refund, or a parcel that may have left, stays a decision in
 * Medusa (which would answer such a cancel with an error anyway).
 */
async function cancel(ctx: MedusaContext, orderId: string): Promise<void> {
  const order = await readOrder(ctx, orderId)
  if (order.status === CANCELED_ORDER_STATUS) return
  if (hasCapturedPayment(order) || liveFulfillments(order).length > 0) {
    ctx.log('Medusa order not cancelled: it has a captured payment or a fulfillment; cancel it in Medusa', { orderId })
    return
  }
  await request(ctx, { method: 'POST', path: `orders/${encodeURIComponent(orderId)}/cancel`, schema: z.unknown(), what: 'order cancel' })
}

/** An Order phase to Medusa: `shipped` fulfils and ships, `cancelled` cancels, `new` and `processing` change nothing (no request). */
export async function updateOrderStatus(ctx: MedusaContext, input: { orderExternalId: string; phase: OrderPhase }): Promise<void> {
  const action = actionForPhase(input.phase)
  if (action === 'ship') await ship(ctx, input.orderExternalId)
  else if (action === 'cancel') await cancel(ctx, input.orderExternalId)
}
