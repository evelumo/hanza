import type { AttentionReason } from '@hanza/db'

const ORDER: AttentionReason[] = ['unmatched_line', 'shortage', 'cancelled_while_processing', 'channel_fact_conflict']

/** Adds reasons in a stable order; `added` holds only the ones that were not present. */
export function addReasons(current: AttentionReason[], add: AttentionReason[]): { reasons: AttentionReason[]; added: AttentionReason[] } {
  const added = [...new Set(add)].filter((reason) => !current.includes(reason))
  const all = new Set([...current, ...added])
  return { reasons: ORDER.filter((reason) => all.has(reason)), added }
}

export function removeReasons(current: AttentionReason[], remove: AttentionReason[]): AttentionReason[] {
  return current.filter((reason) => !remove.includes(reason))
}

/**
 * A cancelled Order has nothing left to reserve or ship, so `shortage` and `unmatched_line` stop mattering.
 * Shipped Orders keep `unmatched_line`: an Unmatched line consumed no Stock, and linking it later corrects that.
 */
export function reasonsAfterCancel(current: AttentionReason[]): AttentionReason[] {
  return removeReasons(current, ['shortage', 'unmatched_line'])
}
