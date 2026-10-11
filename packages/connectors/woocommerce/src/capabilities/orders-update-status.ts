import { PermanentError, type OrderPhase } from '@hanza/connector-sdk'
import { wooOrderStatusSchema } from '../api'
import { request, requestIfFound } from '../client'
import { phaseSetsStatus, targetStatus } from '../mapping/status'
import type { WooCommerceContext } from '../settings'

const ORDER_ID = /^[1-9]\d{0,15}$/

/** The id of a WooCommerce order, or null for anything else (an Order of another Channel, a mistyped id). */
export function parseOrderId(externalId: string): number | null {
  if (!ORDER_ID.test(externalId)) return null
  const id = Number(externalId)
  return Number.isSafeInteger(id) ? id : null
}

// Only the status travels: the answer to a status change would otherwise carry the whole order, Buyer included.
const STATUS_FIELDS = ['id', 'status']

/**
 * `orders.updateStatus`: reads the order, then moves it forward to the status of the phase (`targetStatus`), or
 * leaves it alone. Reading first is what makes the call repeatable and keeps it away from an order WooCommerce
 * already closed: a `PUT` to an order in the trash would take it out again. `set_paid` is never sent.
 */
export async function updateOrderStatus(ctx: WooCommerceContext, input: { orderExternalId: string; phase: OrderPhase }): Promise<void> {
  const id = parseOrderId(input.orderExternalId)
  if (id === null) throw new PermanentError('The Order\'s external id is not a WooCommerce order id')
  if (!phaseSetsStatus(input.phase)) return

  const path = `orders/${id}`
  const query = { _fields: STATUS_FIELDS }
  const order = await requestIfFound(ctx, { path, query, schema: wooOrderStatusSchema, what: 'order' })
  // Deleted for good. Retrying cannot bring it back, and a person should see that the status was not set.
  if (order === null) throw new PermanentError(`Order ${id} no longer exists in the shop`)

  const status = targetStatus(order.data.status, input.phase)
  if (status === null) return
  // An order deleted between the two requests answers 400 here, which is permanent as well.
  await request(ctx, { method: 'PUT', path, query, body: { status }, schema: wooOrderStatusSchema, what: 'order' })
}
