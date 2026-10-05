import type { AttentionReason } from '@hanza/db'

// A rank for every reason: a reason added to the enum but not here fails to compile instead of being dropped.
const RANK = {
  unmatched_line: 0,
  shortage: 1,
  cancelled_while_processing: 2,
  channel_fact_conflict: 3,
  status_push_failed: 4,
} as const satisfies Record<AttentionReason, number>

/** Adds reasons in a stable order; `added` holds only the ones that were not present. */
export function addReasons(current: AttentionReason[], add: AttentionReason[]): { reasons: AttentionReason[]; added: AttentionReason[] } {
  const added = [...new Set(add)].filter((reason) => !current.includes(reason))
  const all = new Set([...current, ...added])
  return { reasons: [...all].sort((a, b) => RANK[a] - RANK[b]), added }
}

export function removeReasons(current: AttentionReason[], remove: AttentionReason[]): AttentionReason[] {
  return current.filter((reason) => !remove.includes(reason))
}
