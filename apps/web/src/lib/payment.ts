import type { OrderStatus } from '@hanza/connector-sdk'

/**
 * Whether the panel marks the Order Awaiting payment. A cancelled Order that was never paid is an abandoned
 * checkout, not something to wait for (the stored flag stays: a late payment on it needs a person, ADR 0011);
 * a shipped one keeps the mark, it means shipped without payment.
 */
export function showsAwaitingPayment(order: { status: OrderStatus; awaitingPayment: boolean }): boolean {
  return order.awaitingPayment && order.status !== 'cancelled'
}
