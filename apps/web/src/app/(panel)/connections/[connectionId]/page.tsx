import { getConnection, listEvents } from '@hanza/core'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ActionForm } from '@/components/action-form'
import { ActionButton } from '@/components/form'
import { EmptyState, Section, linkClass, rowClass, tableClass, tdClass, thClass } from '@/components/section'
import { HealthBadge } from '@/components/status-badge'
import { getContext } from '@/lib/context'
import { describeEvent } from '@/lib/events'
import { formatDateTime } from '@/lib/format'
import { streamLabels, syncErrorLabels } from '@/lib/labels'
import { requireTenant } from '@/lib/session'
import { isSyncRunning } from '@/lib/sync-status'
import { requestSyncAction } from '../actions'
import { formatSyncResult } from '../sync-summary'

export const dynamic = 'force-dynamic'

const time = (date: Date | null) => (date ? formatDateTime(date) : '—')

export default async function ConnectionPage({ params }: { params: Promise<{ connectionId: string }> }) {
  const { organizationId } = await requireTenant()
  const { connectionId } = await params
  const ctx = getContext()
  const connection = await getConnection(ctx, organizationId, connectionId)
  if (!connection) notFound()
  const events = await listEvents(ctx, organizationId, { type: 'connection', id: connection.id }, 20)

  return (
    <div className="space-y-6">
      <div>
        <Link href="/connections" className={linkClass}>
          ← Połączenia
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{connection.name}</h1>
          <HealthBadge health={connection.health} />
        </div>
        <p className="mt-1 text-sm text-muted">
          Konektor: {ctx.connectors.get(connection.connectorId)?.name ?? connection.connectorId}
          {connection.healthChangedAt ? ` · stan zmieniony ${formatDateTime(connection.healthChangedAt)}` : ''}
        </p>
      </div>

      <Section
        title="Synchronizacja"
        description="Hanza synchronizuje połączenie w tle. Zlecenie trafia do kolejki, a wyniki pojawią się tu po chwili: odśwież stronę."
        actions={
          <ActionForm action={requestSyncAction} success="Synchronizacja zlecona. Odśwież stronę za chwilę.">
            <ActionButton pendingLabel="Zlecanie…">Synchronizuj teraz</ActionButton>
            <input type="hidden" name="connectionId" value={connection.id} />
          </ActionForm>
        }
      >
        {connection.syncStates.length === 0 ? (
          <EmptyState>Synchronizacja jeszcze się nie odbyła.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th scope="col" className={thClass}>Dane</th>
                  <th scope="col" className={thClass}>Rozpoczęto</th>
                  <th scope="col" className={thClass}>Zakończono</th>
                  <th scope="col" className={thClass}>Ostatni sukces</th>
                  <th scope="col" className={thClass}>Wynik</th>
                  <th scope="col" className={thClass}>Błąd</th>
                </tr>
              </thead>
              <tbody>
                {connection.syncStates.map((state) => (
                  <tr key={state.stream} className={rowClass}>
                    <th scope="row" className={`${tdClass} font-medium`}>{streamLabels[state.stream]}</th>
                    <td className={tdClass}>{time(state.lastStartedAt)}</td>
                    <td className={tdClass}>{isSyncRunning(state) ? 'w toku' : time(state.lastFinishedAt)}</td>
                    <td className={tdClass}>{time(state.lastSucceededAt)}</td>
                    <td className={tdClass}>{formatSyncResult(state.lastResult) ?? '—'}</td>
                    <td className={tdClass}>
                      {state.lastErrorKind ? (
                        <>
                          <span className="font-medium text-red-800">{syncErrorLabels[state.lastErrorKind]}</span>
                          {state.lastError ? <span className="block text-xs text-muted">{state.lastError}</span> : null}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Ostatnie zdarzenia">
        {events.length === 0 ? (
          <EmptyState>Brak zdarzeń.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {events.map((event) => {
              const { title, detail } = describeEvent(event.type, event.payload)
              return (
                <li key={event.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                  <span>
                    {title}
                    {detail ? <span className="text-muted"> · {detail}</span> : null}
                  </span>
                  <time dateTime={event.createdAt.toISOString()} className="text-muted">
                    {formatDateTime(event.createdAt)}
                  </time>
                </li>
              )
            })}
          </ul>
        )}
      </Section>
    </div>
  )
}
