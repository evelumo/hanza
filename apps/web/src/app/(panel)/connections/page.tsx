import { listConnections } from '@hanza/core'
import Link from 'next/link'
import { buttonClass } from '@/components/button-class'
import { EmptyState, linkClass, rowClass, tableClass, tdClass, thClass } from '@/components/section'
import { HealthBadge } from '@/components/status-badge'
import { getContext } from '@/lib/context'
import { formatDateTime } from '@/lib/format'
import { streamLabels, syncErrorLabels } from '@/lib/labels'
import { requireTenant } from '@/lib/session'
import { isSyncRunning } from '@/lib/sync-status'
import { formatSyncResult } from './sync-summary'

export const dynamic = 'force-dynamic'

export default async function ConnectionsPage() {
  const { organizationId } = await requireTenant()
  const ctx = getContext()
  const connections = await listConnections(ctx, organizationId)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Połączenia</h1>
        <Link href="/connections/new" className={buttonClass('primary')}>
          Dodaj połączenie
        </Link>
      </div>

      <div className="rounded-lg border border-line bg-white">
        {connections.length === 0 ? (
          <EmptyState>Nie ma jeszcze połączeń. Dodaj połączenie z kanałem, żeby pobierać oferty i zamówienia.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th scope="col" className={thClass}>Nazwa</th>
                  <th scope="col" className={thClass}>Konektor</th>
                  <th scope="col" className={thClass}>Stan połączenia</th>
                  <th scope="col" className={thClass}>Ostatnia synchronizacja</th>
                </tr>
              </thead>
              <tbody>
                {connections.map((connection) => (
                  <tr key={connection.id} className={rowClass}>
                    <td className={tdClass}>
                      <Link href={`/connections/${connection.id}`} className={linkClass}>
                        {connection.name}
                      </Link>
                    </td>
                    <td className={tdClass}>{ctx.connectors.get(connection.connectorId)?.name ?? connection.connectorId}</td>
                    <td className={tdClass}>
                      <HealthBadge health={connection.health} />
                    </td>
                    <td className={tdClass}>
                      {connection.syncStates.length === 0 ? (
                        <span className="text-muted">jeszcze nie uruchomiono</span>
                      ) : (
                        <ul className="space-y-1">
                          {connection.syncStates.map((state) => (
                            <li key={state.stream}>
                              <span className="font-medium">{streamLabels[state.stream]}:</span>{' '}
                              {state.lastErrorKind ? (
                                <span className="text-red-800">{syncErrorLabels[state.lastErrorKind]}</span>
                              ) : state.lastSucceededAt ? (
                                <>
                                  {formatDateTime(state.lastSucceededAt)}
                                  {formatSyncResult(state.lastResult) ? <span className="text-muted"> · {formatSyncResult(state.lastResult)}</span> : null}
                                </>
                              ) : (
                                <span className="text-muted">{isSyncRunning(state) ? 'w toku' : '—'}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
