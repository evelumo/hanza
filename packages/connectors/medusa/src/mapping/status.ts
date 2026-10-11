import type { ChannelFact, OrderPhase } from '@hanza/connector-sdk'
import type { HanzaSettings, MedusaOrder, MedusaPayment } from '../api'

// How Medusa's statuses become Channel facts and back. Medusa's order `status` stays `pending` until someone completes
// or cancels the order, also once it is shipped, so "open" is read from the facts, not from `status`.

/** The order statuses the feed lists at its start: an order nobody completed, cancelled or archived. */
export const LISTED_ORDER_STATUSES = ['pending', 'requires_action'] as const
export const CANCELED_ORDER_STATUS = 'canceled'
/** `payment_status` values that mean the money was taken (and stays a `paid` fact after a refund). */
export const PAID_PAYMENT_STATUSES: readonly string[] = ['captured', 'partially_refunded', 'refunded']
/** Added to the paid ones when the plugin's `paid_when` is `authorized`. */
export const AUTHORIZED_PAYMENT_STATUS = 'authorized'
/** `fulfillment_status` values that mean every item left the store; `partially_shipped` is still open (#149). */
export const SHIPPED_FULFILLMENT_STATUSES: readonly string[] = ['shipped', 'delivered']

/** What of the plugin's settings the mapping reads. */
export type OrderRules = Pick<HanzaSettings, 'pay_on_delivery_provider_ids' | 'paid_when'>

export function paymentsOf(order: Pick<MedusaOrder, 'payment_collections'>): MedusaPayment[] {
  return (order.payment_collections ?? []).flatMap((collection) => collection.payments ?? [])
}

/** Cash on delivery: any payment of the order went through a provider the plugin's settings name as pay on delivery. */
export function isCashOnDelivery(order: Pick<MedusaOrder, 'payment_collections'>, rules: OrderRules): boolean {
  return paymentsOf(order).some((payment) => rules.pay_on_delivery_provider_ids.includes(payment.provider_id))
}

function latest(times: Array<string | null | undefined>): string | null {
  let found: string | null = null
  for (const time of times) {
    if (time === null || time === undefined) continue
    if (found === null || Date.parse(time) > Date.parse(found)) found = time
  }
  return found
}

/**
 * Every Channel fact the order shows now, oldest first. Ids are `<order id>:<type>`, the same on every pull whatever
 * the time is by then. The facts follow the snapshot: once the money was taken the `paid` fact stays, also after a
 * refund.
 */
export function orderFacts(order: MedusaOrder, rules: OrderRules): ChannelFact[] {
  const facts: ChannelFact[] = []
  const paidStatuses = rules.paid_when === 'authorized' ? [...PAID_PAYMENT_STATUSES, AUTHORIZED_PAYMENT_STATUS] : PAID_PAYMENT_STATUSES
  if (!isCashOnDelivery(order, rules) && paidStatuses.includes(order.payment_status ?? '')) {
    const capturedAt = latest(paymentsOf(order).map((payment) => payment.captured_at))
    facts.push({ id: `${order.id}:paid`, type: 'paid', occurredAt: capturedAt ?? order.updated_at, note: null })
  }
  if (SHIPPED_FULFILLMENT_STATUSES.includes(order.fulfillment_status ?? '')) {
    const live = (order.fulfillments ?? []).filter((fulfillment) => !fulfillment.canceled_at)
    const shippedAt = latest(live.map((fulfillment) => fulfillment.shipped_at))
    facts.push({ id: `${order.id}:shipped`, type: 'shipped', occurredAt: shippedAt ?? order.updated_at, note: null })
  }
  if (order.status === CANCELED_ORDER_STATUS) {
    facts.push({ id: `${order.id}:cancelled`, type: 'cancelled', occurredAt: order.canceled_at ?? order.updated_at, note: null })
  }
  // The sort is stable, so facts of one moment stay paid, shipped, cancelled.
  return facts.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
}

/** Open: neither shipped nor cancelled, as far as the facts say. A closed order is never imported in full from the listing. */
export function isOpen(order: MedusaOrder, rules: OrderRules): boolean {
  return !orderFacts(order, rules).some((fact) => fact.type === 'shipped' || fact.type === 'cancelled')
}

/** What `orders.updateStatus` does for a phase: nothing for `new` and `processing`, which Medusa has no status for. */
export function actionForPhase(phase: OrderPhase): 'none' | 'ship' | 'cancel' {
  if (phase === 'shipped') return 'ship'
  if (phase === 'cancelled') return 'cancel'
  return 'none'
}
