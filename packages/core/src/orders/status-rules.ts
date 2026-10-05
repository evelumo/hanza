import type { ChannelFactType } from '@hanza/connector-sdk'
import type { AttentionReason } from '@hanza/db'
import type { OrderPhase } from './phases'

const MANUAL: Record<OrderPhase, OrderPhase[]> = {
  new: ['processing', 'shipped', 'cancelled'],
  processing: ['new', 'shipped', 'cancelled'],
  shipped: [],
  cancelled: [],
}

/** To which other phase a person may move an Order in `phase`; shipped and cancelled are final. */
export function allowedTransitions(phase: OrderPhase): OrderPhase[] {
  return [...MANUAL[phase]]
}

/**
 * Whether a person may move an Order from its status to `to` (ADR 0014): any other active status of the same phase,
 * in every phase (it changes nothing the core relies on), or of a phase `allowedTransitions` reaches.
 */
export function canMoveToStatus(
  current: { phase: OrderPhase; statusId: string },
  to: { id: string; phase: OrderPhase; active: boolean },
): boolean {
  if (!to.active || to.id === current.statusId) return false
  return to.phase === current.phase || MANUAL[current.phase].includes(to.phase)
}

/** The statuses a person may move the Order to, in the order given. */
export function allowedStatuses<T extends { id: string; phase: OrderPhase; active: boolean }>(
  current: { phase: OrderPhase; statusId: string },
  statuses: T[],
): T[] {
  return statuses.filter((status) => canMoveToStatus(current, status))
}

const FACTS: Record<OrderPhase, Record<ChannelFactType, { to: OrderPhase | null; reason: AttentionReason | null }>> = {
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

/** What a Channel fact does to an Order in `phase` (ADR 0003); `to` null = phase (and status) unchanged. */
export function factTransition(phase: OrderPhase, fact: ChannelFactType): { to: OrderPhase | null; reason: AttentionReason | null } {
  return { ...FACTS[phase][fact] }
}
