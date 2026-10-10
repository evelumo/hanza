import type { SyncErrorKind } from '@hanza/db'
import { CircleDashed, KeyRound, OctagonAlert, RefreshCw, TriangleAlert, type LucideIcon } from 'lucide-react'
import { toneTextClass, type Tone } from '@/components/tone'
import { Badge } from '@/components/ui/badge'
import { useT } from '@/i18n/use-t'
import { syncErrorLabel } from '@/lib/labels'
import { syncStatus } from '@/lib/sync-status'
import { cn } from '@/lib/utils'

// A rate limit or a temporary error clears on a later run, so it is a warning; a permanent one waits for a
// person. A sign-in that stopped working looks as it does in `HealthBadge`.
const errorLook: Record<SyncErrorKind, { tone: Tone; icon: LucideIcon }> = {
  auth_expired: { tone: 'warning', icon: KeyRound },
  rate_limited: { tone: 'warning', icon: TriangleAlert },
  transient: { tone: 'warning', icon: TriangleAlert },
  permanent: { tone: 'critical', icon: OctagonAlert },
}

/** The kind of error the last run ended with, as a line of text: for a row that has no room for a badge. */
export function SyncErrorText({ kind, className }: { kind: SyncErrorKind; className?: string }) {
  const t = useT()
  const { icon: Icon, tone } = errorLook[kind]
  return (
    <span className={cn('inline-flex items-center gap-1 font-medium', toneTextClass[tone], className)}>
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      {syncErrorLabel(t, kind)}
    </span>
  )
}

export interface StreamState {
  lastStartedAt: Date | null
  lastFinishedAt: Date | null
  lastSucceededAt: Date | null
  lastErrorKind: SyncErrorKind | null
}

/** How the last run of one kind of data ended, in words. An error outranks everything else, as in `syncStatus`. */
export function SyncStatusBadge({ state }: { state: StreamState }) {
  const t = useT()
  if (state.lastErrorKind) {
    const { tone, icon } = errorLook[state.lastErrorKind]
    return (
      <Badge tone={tone} icon={icon}>
        {syncErrorLabel(t, state.lastErrorKind)}
      </Badge>
    )
  }
  switch (syncStatus(state)) {
    case 'succeeded':
      return <Badge tone="success">{t('connections.syncStatus.succeeded')}</Badge>
    case 'running':
      return (
        <Badge tone="info" icon={RefreshCw}>
          {t('connections.syncStatus.running')}
        </Badge>
      )
    default:
      // A run that had nothing to send never calls the Channel, so it leaves only the time it finished.
      return <Badge icon={CircleDashed}>{state.lastFinishedAt ? t('connections.syncStatus.nothingToSend') : t('connections.syncStatus.notRun')}</Badge>
  }
}
