import type { OrderPhase } from '@hanza/core'

/**
 * Whether the panel marks the Order Awaiting payment. A cancelled Order that was never paid is an abandoned
 * checkout, not something to wait for (the stored flag stays: a late payment on it needs a person, ADR 0015);
 * a shipped one keeps the mark, it means shipped without payment.
 */
export function showsAwaitingPayment(order: { phase: OrderPhase; awaitingPayment: boolean }): boolean {
  return order.awaitingPayment && order.phase !== 'cancelled'
}
