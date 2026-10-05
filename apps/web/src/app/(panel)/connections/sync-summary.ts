import { labelOf, syncResultLabels } from '@/lib/labels'

/** "widziane 5, nowe 2" from `sync_state.lastResult`. */
export function formatSyncResult(result: Record<string, number> | null): string | null {
  if (!result) return null
  const parts = Object.entries(result)
    .filter(([, value]) => typeof value === 'number')
    .map(([key, value]) => `${labelOf(syncResultLabels, key)} ${value}`)
  return parts.length > 0 ? parts.join(', ') : null
}
