import type { ChannelFactType, OrderStatus } from '@hanza/connector-sdk'
import type { AttentionReason } from '@hanza/db'

const MANUAL: Record<OrderStatus, OrderStatus[]> = {
  new: ['processing', 'shipped', 'cancelled'],
  processing: ['new', 'shipped', 'cancelled'],
  shipped: [],
  cancelled: [],
}

/** Where a person may move an Order from `status` (§2). */
export function allowedTransitions(status: OrderStatus): OrderStatus[] {
  return [...MANUAL[status]]
}

const FACTS: Record<OrderStatus, Record<ChannelFactType, { to: OrderStatus | null; reason: AttentionReason | null }>> = {
  new: {
    cancelled: { to: 'cancelled', reason: null },
    shipped: { to: 'shipped', reason: null },
  },
  processing: {
    cancelled: { to: 'cancelled', reason: 'cancelled_while_processing' },
    shipped: { to: 'shipped', reason: null },
  },
  shipped: {
    cancelled: { to: null, reason: 'channel_fact_conflict' },
    shipped: { to: null, reason: null },
  },
  cancelled: {
    cancelled: { to: null, reason: null },
    shipped: { to: null, reason: 'channel_fact_conflict' },
  },
}

/** What a Channel fact does to an Order in `status` (§2); `to` null = status unchanged. */
export function factTransition(status: OrderStatus, fact: ChannelFactType): { to: OrderStatus | null; reason: AttentionReason | null } {
  return { ...FACTS[status][fact] }
}
