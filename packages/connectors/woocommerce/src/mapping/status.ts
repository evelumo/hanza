import type { OrderPhase } from '@hanza/connector-sdk'

// WooCommerce order statuses, in both directions. Any status can follow any other in WooCommerce (an admin picks
// one from a list), so nothing here assumes an order of events.

/** The statuses of an order a seller still has to fulfil: what the feed lists when a Connection starts. */
export const OPEN_STATUSES = ['pending', 'on-hold', 'processing'] as const

/** The Buyer does not get the goods: reported as a `cancelled` Channel fact. */
export const CANCELLED_STATUSES: readonly string[] = ['cancelled', 'refunded', 'failed', 'trash']

/** Nothing is left to do for the seller, so Hanza never changes such an order. */
const CLOSED_STATUSES: readonly string[] = ['completed', ...CANCELLED_STATUSES]

/** A checkout that was opened and never placed: not an order yet. */
const DRAFT_STATUSES: readonly string[] = ['checkout-draft', 'auto-draft']

/** The statuses from which a prepaid order counts as paid even when WooCommerce recorded no payment date. */
export const PAID_STATUSES: readonly string[] = ['processing', 'completed']

/** `status=any` leaves these out; the feed never reports one should a shop send it anyway. */
export function isDraftStatus(status: string): boolean {
  return DRAFT_STATUSES.includes(status)
}

export type WooTargetStatus = 'processing' | 'completed' | 'cancelled'

/** Whether a phase can change an order at all. `new` never does, so the order is not even read for it. */
export function phaseSetsStatus(phase: OrderPhase): boolean {
  return phase !== 'new'
}

/**
 * The status `orders.updateStatus` sets for an Order phase, given the order's status now; null for "no call".
 * Forward only: an order is never reopened, and one WooCommerce already closed is left alone.
 */
export function targetStatus(current: string, phase: OrderPhase): WooTargetStatus | null {
  if (DRAFT_STATUSES.includes(current)) return null
  switch (phase) {
    case 'new':
      return null
    case 'processing':
      return current === 'pending' || current === 'on-hold' || current === 'failed' ? 'processing' : null
    case 'shipped':
      return CLOSED_STATUSES.includes(current) ? null : 'completed'
    case 'cancelled':
      return CLOSED_STATUSES.includes(current) ? null : 'cancelled'
  }
}
