import type { AttentionReason } from '@hanza/db'

const ORDER: AttentionReason[] = ['unmatched_line', 'shortage', 'cancelled_while_processing', 'channel_fact_conflict', 'status_push_failed']

/** Adds reasons in a stable order; `added` holds only the ones that were not present. */
export function addReasons(current: AttentionReason[], add: AttentionReason[]): { reasons: AttentionReason[]; added: AttentionReason[] } {
  const added = [...new Set(add)].filter((reason) => !current.includes(reason))
  const all = new Set([...current, ...added])
  return { reasons: ORDER.filter((reason) => all.has(reason)), added }
}

export function removeReasons(current: AttentionReason[], remove: AttentionReason[]): AttentionReason[] {
  return current.filter((reason) => !remove.includes(reason))
}
