import type { AttentionReason, ConnectionHealth, SyncErrorKind, SyncStream } from '@hanza/db'

export type SetupStepId = 'connect' | 'products' | 'stock'

export interface SetupStep {
  id: SetupStepId
  href: string
  done: boolean
}

/**
 * The first-run path of `docs/demo.md`, read from what the organization has. Nothing is stored, so a step is
 * open again when its state goes away (the last Connection deleted, no Stock left anywhere). Null once every
 * step is done.
 */
export function setupSteps(state: { connections: number; linkedOffers: number; stockRows: number }): SetupStep[] | null {
  const steps: SetupStep[] = [
    { id: 'connect', href: '/connections/new', done: state.connections > 0 },
    { id: 'products', href: '/products/offers', done: state.linkedOffers > 0 },
    { id: 'stock', href: '/products', done: state.stockRows > 0 },
  ]
  return steps.every((step) => step.done) ? null : steps
}

// A place for every reason: a reason added to the enum but not here fails to compile instead of being dropped.
const REASON_ORDER = {
  unmatched_line: 0,
  shortage: 1,
  cancelled_while_processing: 2,
  channel_fact_conflict: 3,
  status_push_failed: 4,
} as const satisfies Record<AttentionReason, number>

export interface AttentionOrders {
  /** Orders that need attention. */
  total: number
  /** Orders per reason. An Order with two reasons is under both, so these can add up to more than `total`. */
  reasons: Array<{ reason: AttentionReason; count: number }>
}

/** From the number of Orders per distinct set of reasons, as one `groupBy` returns them. */
export function summarizeAttention(groups: Array<{ reasons: AttentionReason[]; orders: number }>): AttentionOrders {
  const perReason = new Map<AttentionReason, number>()
  let total = 0
  for (const group of groups) {
    const reasons = new Set(group.reasons)
    if (reasons.size === 0) continue
    total += group.orders
    for (const reason of reasons) perReason.set(reason, (perReason.get(reason) ?? 0) + group.orders)
  }
  return {
    total,
    reasons: [...perReason].map(([reason, count]) => ({ reason, count })).sort((a, b) => REASON_ORDER[a.reason] - REASON_ORDER[b.reason]),
  }
}

export interface ConnectionState {
  id: string
  name: string
  health: ConnectionHealth
  syncStates: Array<{ stream: SyncStream; lastErrorKind: SyncErrorKind | null }>
}

export type AttentionItem =
  | { kind: 'connection_failing'; href: string; name: string; errors: Array<{ stream: SyncStream; kind: SyncErrorKind }> }
  | { kind: 'connection_sign_in'; href: string; name: string }
  | ({ kind: 'orders'; href: string } & AttentionOrders)
  | { kind: 'unlinked_offers'; href: string; count: number }

/**
 * What waits for a person, most blocking first: a Connection that does not synchronise makes every number
 * after it stale, so Connections come before the Orders and the Offers. Empty when nothing waits.
 */
export function attentionItems(state: {
  connections: ConnectionState[]
  orders: AttentionOrders
  unlinkedOffers: number
}): AttentionItem[] {
  const items: AttentionItem[] = []
  const href = (connectionId: string) => `/connections/${connectionId}`

  for (const connection of state.connections) {
    if (connection.health !== 'failing') continue
    const errors = connection.syncStates.flatMap((sync) => (sync.lastErrorKind ? [{ stream: sync.stream, kind: sync.lastErrorKind }] : []))
    items.push({ kind: 'connection_failing', href: href(connection.id), name: connection.name, errors })
  }
  for (const connection of state.connections) {
    if (connection.health === 'auth_expired') items.push({ kind: 'connection_sign_in', href: href(connection.id), name: connection.name })
  }
  if (state.orders.total > 0) items.push({ kind: 'orders', href: '/orders?attention=1', ...state.orders })
  if (state.unlinkedOffers > 0) items.push({ kind: 'unlinked_offers', href: '/products/offers', count: state.unlinkedOffers })
  return items
}

/** How many Connections the dashboard lists before it points at the Connections page. */
export const CONNECTIONS_SHOWN = 6

const HEALTH_ORDER = { failing: 0, auth_expired: 1, unknown: 2, ok: 3 } as const satisfies Record<ConnectionHealth, number>

/** The Connections to list, the ones in trouble first (otherwise in the order given), and how many are left out. */
export function connectionsToShow<T extends { health: ConnectionHealth }>(connections: T[], limit = CONNECTIONS_SHOWN): { shown: T[]; more: number } {
  const sorted = [...connections].sort((a, b) => HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health])
  return { shown: sorted.slice(0, limit), more: Math.max(0, sorted.length - limit) }
}

/** When any of the Connection's streams last finished without an error; null when none has yet. */
export function lastSynchronisedAt(syncStates: Array<{ lastSucceededAt: Date | null }>): Date | null {
  let latest: Date | null = null
  for (const { lastSucceededAt } of syncStates) {
    if (lastSucceededAt && (!latest || lastSucceededAt > latest)) latest = lastSucceededAt
  }
  return latest
}
