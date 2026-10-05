import { listConnections } from '@hanza/core'
import type { Metadata } from 'next'
import Link from 'next/link'
import { buttonClass } from '@/components/button-class'
import { EmptyState, linkClass, rowClass, tableClass, tdClass, thClass } from '@/components/section'
import { HealthBadge } from '@/components/status-badge'
import { getT } from '@/i18n/server'
import { getContext } from '@/lib/context'
import { getActiveLocale } from '@/i18n/server'
import { getFormatters } from '@/lib/formatters'
import { streamLabel, syncErrorLabel } from '@/lib/labels'
import { requireTenant } from '@/lib/session'
import { isSyncRunning } from '@/lib/sync-status'
import { formatSyncResult } from './sync-summary'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('connections.title') }
}

export default async function ConnectionsPage() {
  const { organizationId } = await requireTenant()
  const [t, format, locale] = await Promise.all([getT(), getFormatters(), getActiveLocale()])
  const ctx = getContext()
  const connections = await listConnections(ctx, organizationId)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t('connections.title')}</h1>
        <Link href="/connections/new" className={buttonClass('primary')}>
          {t('connections.add')}
        </Link>
      </div>

      <div className="rounded-lg border border-line bg-white">
        {connections.length === 0 ? (
          <EmptyState>{t('connections.empty')}</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th scope="col" className={thClass}>{t('connections.columns.name')}</th>
                  <th scope="col" className={thClass}>{t('connections.columns.connector')}</th>
                  <th scope="col" className={thClass}>{t('connections.columns.health')}</th>
                  <th scope="col" className={thClass}>{t('connections.columns.lastSync')}</th>
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
                        <span className="text-muted">{t('connections.neverSynced')}</span>
                      ) : (
                        <ul className="space-y-1">
                          {connection.syncStates.map((state) => (
                            <li key={state.stream}>
                              <span className="font-medium">{streamLabel(t, state.stream)}:</span>{' '}
                              {state.lastErrorKind ? (
                                <span className="text-red-800">{syncErrorLabel(t, state.lastErrorKind)}</span>
                              ) : state.lastSucceededAt ? (
                                <>
                                  {format.dateTime(state.lastSucceededAt)}
                                  {formatSyncResult(state.lastResult, t, locale) ? (
                                    <span className="text-muted"> · {formatSyncResult(state.lastResult, t, locale)}</span>
                                  ) : null}
                                </>
                              ) : (
                                <span className="text-muted">{isSyncRunning(state) ? t('connections.running') : '—'}</span>
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
