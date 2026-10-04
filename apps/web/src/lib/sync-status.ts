export interface SyncStatusInput {
  lastStartedAt: Date | null
  lastFinishedAt: Date | null
  lastSucceededAt: Date | null
  lastErrorKind: string | null
}

export type SyncStatus = 'failed' | 'succeeded' | 'running' | 'idle'

// A run that made no Channel call only sets lastFinishedAt, so "no success yet" does not mean "in flight".
export function isSyncRunning(state: Pick<SyncStatusInput, 'lastStartedAt' | 'lastFinishedAt'>): boolean {
  if (!state.lastStartedAt) return false
  return !state.lastFinishedAt || state.lastStartedAt > state.lastFinishedAt
}

export function syncStatus(state: SyncStatusInput): SyncStatus {
  if (state.lastErrorKind) return 'failed'
  if (state.lastSucceededAt) return 'succeeded'
  return isSyncRunning(state) ? 'running' : 'idle'
}
