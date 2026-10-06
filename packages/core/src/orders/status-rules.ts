import type { ChannelFactType } from '@hanza/connector-sdk'
import type { AttentionReason } from '@hanza/db'
import type { OrderPhase } from './phases'

/** Phases still in fulfilment; shipped and cancelled are final. */
export const OPEN_PHASES: OrderPhase[] = ['new', 'processing']

/** No phase follows these; an Order's `closedAt` is when it reached one. */
export const FINAL_PHASES = ['shipped', 'cancelled'] as const satisfies readonly OrderPhase[]

export function isFinalPhase(phase: OrderPhase): boolean {
  return (FINAL_PHASES as readonly OrderPhase[]).includes(phase)
}

const MANUAL: Record<OrderPhase, OrderPhase[]> = {
  new: ['processing', 'shipped', 'cancelled'],
  processing: ['new', 'shipped', 'cancelled'],
  shipped: [],
  cancelled: [],
}

/**
 * To which other phase a person may move an Order in `phase`; shipped and cancelled are final. An Order awaiting
 * payment can only be cancelled.
 */
export function allowedTransitions(phase: OrderPhase, awaitingPayment = false): OrderPhase[] {
  return MANUAL[phase].filter((to) => !awaitingPayment || to === 'cancelled')
}

/** What `canMoveToStatus` needs to know about the Order. */
export type StatusMoveFrom = { phase: OrderPhase; statusId: string; awaitingPayment?: boolean }

/**
 * Whether a person may move an Order from its status to `to` (ADR 0018): any other active status of the same phase,
 * in every phase (it changes nothing the core relies on), or of a phase `allowedTransitions` reaches. Every phase
 * rule goes through `allowedTransitions`, so an unpaid Order may change its label within phase new but leave new only
 * to cancelled.
 */
export function canMoveToStatus(current: StatusMoveFrom, to: { id: string; phase: OrderPhase; active: boolean }): boolean {
  if (!to.active || to.id === current.statusId) return false
  return to.phase === current.phase || allowedTransitions(current.phase, current.awaitingPayment).includes(to.phase)
}

/** The statuses a person may move the Order to, in the order given. */
export function allowedStatuses<T extends { id: string; phase: OrderPhase; active: boolean }>(
  current: StatusMoveFrom,
  statuses: T[],
): T[] {
  return statuses.filter((status) => canMoveToStatus(current, status))
}

type FactEffect = { to: OrderPhase | null; reason: AttentionReason | null }

// `paid` never moves the phase; its effect on the payment state is decided in `factTransition`.
const FACTS: Record<OrderPhase, Record<ChannelFactType, FactEffect>> = {
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
 * What a Channel fact does to an Order in `phase` (ADR 0003); `to` null = phase (and status) unchanged.
 * `paid` is true when the fact ends the wait for payment; money for an Order already cancelled needs a person.
 */
export function factTransition(
  phase: OrderPhase,
  fact: ChannelFactType,
  awaitingPayment = false,
): FactEffect & { paid: boolean } {
  const paid = fact === 'paid' && awaitingPayment
  if (paid && phase === 'cancelled') return { to: null, reason: 'channel_fact_conflict', paid }
  return { ...FACTS[phase][fact], paid }
}
