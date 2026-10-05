import type { Locale } from '@/i18n/config'
import type { Translator } from '@/i18n/types'
import { formatNumber } from '@/lib/format'
import { labelOrRaw } from '@/lib/labels'

/** "seen 5, new 2" from `sync_state.lastResult`, in the request's language. */
export function formatSyncResult(result: Record<string, number> | null, t: Translator, locale: Locale): string | null {
  if (!result) return null
  const parts = Object.entries(result)
    .filter(([, value]) => typeof value === 'number')
    .map(([key, value]) => `${labelOrRaw(t, 'sync.result', key)} ${formatNumber(value, locale)}`)
  return parts.length > 0 ? parts.join(', ') : null
}
