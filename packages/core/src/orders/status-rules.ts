import type { ChannelFactType, OrderStatus } from '@hanza/connector-sdk'
import type { AttentionReason } from '@hanza/db'

/** Orders still in fulfilment; shipped and cancelled are final. */
export const OPEN_STATUSES: OrderStatus[] = ['new', 'processing']

const MANUAL: Record<OrderStatus, OrderStatus[]> = {
  new: ['processing', 'shipped', 'cancelled'],
  processing: ['new', 'shipped', 'cancelled'],
  shipped: [],
  cancelled: [],
}

/** No status follows these; an Order's `closedAt` is when it reached one. */
export const FINAL_STATUSES = ['shipped', 'cancelled'] as const satisfies readonly OrderStatus[]

export function isFinalStatus(status: OrderStatus): boolean {
  return (FINAL_STATUSES as readonly OrderStatus[]).includes(status)
}

/** Where a person may move an Order from `status`; shipped and cancelled are final. An Order awaiting payment can only be cancelled. */
export function allowedTransitions(status: OrderStatus, awaitingPayment = false): OrderStatus[] {
  return MANUAL[status].filter((to) => !awaitingPayment || to === 'cancelled')
}

type FactEffect = { to: OrderStatus | null; reason: AttentionReason | null }

// `paid` never moves the status; its effect on the payment state is decided in `factTransition`.
const FACTS: Record<OrderStatus, Record<ChannelFactType, FactEffect>> = {
  new: {
    cancelled: { to: 'cancelled', reason: null },
    shipped: { to: 'shipped', reason: null },
    paid: { to: null, reason: null },
  },
  processing: {
    cancelled: { to: 'cancelled', reason: 'cancelled_while_processing' },
    shipped: { to: 'shipped', reason: null },
    paid: { to: null, reason: null },
  },
  shipped: {
    cancelled: { to: null, reason: 'channel_fact_conflict' },
    shipped: { to: null, reason: null },
    paid: { to: null, reason: null },
  },
  cancelled: {
    cancelled: { to: null, reason: null },
    shipped: { to: null, reason: 'channel_fact_conflict' },
    paid: { to: null, reason: null },
  },
}

/**
 * What a Channel fact does to an Order in `status` (ADR 0003); `to` null = status unchanged.
 * `paid` is true when the fact ends the wait for payment; money for an Order already cancelled needs a person.
 */
export function factTransition(
  status: OrderStatus,
  fact: ChannelFactType,
  awaitingPayment = false,
): FactEffect & { paid: boolean } {
  const paid = fact === 'paid' && awaitingPayment
  if (paid && status === 'cancelled') return { to: null, reason: 'channel_fact_conflict', paid }
  return { ...FACTS[status][fact], paid }
}
