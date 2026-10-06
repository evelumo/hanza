import { getConnection, listEvents } from '@hanza/core'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ActionForm } from '@/components/action-form'
import { ActionButton } from '@/components/form'
import { EmptyState, Section, linkClass, rowClass, tableClass, tdClass, thClass } from '@/components/section'
import { HealthBadge } from '@/components/status-badge'
import { getActiveLocale, getT } from '@/i18n/server'
import { getContext } from '@/lib/context'
import { describeEvent } from '@/lib/events'
import { getFormatters } from '@/lib/formatters'
import { streamLabel, syncErrorLabel } from '@/lib/labels'
import { requireTenant } from '@/lib/session'
import { isSyncRunning } from '@/lib/sync-status'
import { requestSyncAction } from '../actions'
import { formatSyncResult } from '../sync-summary'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('connections.detail.title') }
}

export default async function ConnectionPage({ params }: { params: Promise<{ connectionId: string }> }) {
  const { organizationId } = await requireTenant()
  const [t, format, locale] = await Promise.all([getT(), getFormatters(), getActiveLocale()])
  const time = (date: Date | null) => (date ? format.dateTime(date) : '—')
  const { connectionId } = await params
  const ctx = getContext()
  const connection = await getConnection(ctx, organizationId, connectionId)
  if (!connection) notFound()
  const connectorName = ctx.connectors.get(connection.connectorId)?.name ?? connection.connectorId
  const events = await listEvents(ctx, organizationId, { type: 'connection', id: connection.id }, 20)

  return (
    <div className="space-y-6">
      <div>
        <Link href="/connections" className={linkClass}>
          ← {t('connections.title')}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{connection.name}</h1>
          <HealthBadge health={connection.health} />
        </div>
        <p className="mt-1 text-sm text-muted">
          {connection.healthChangedAt
            ? t('connections.detail.connectorLineChanged', { connector: connectorName, date: format.dateTime(connection.healthChangedAt) })
            : t('connections.detail.connectorLine', { connector: connectorName })}
        </p>
      </div>

      <Section
        title={t('connections.detail.syncTitle')}
        description={t('connections.detail.syncDescription')}
        actions={
          <ActionForm action={requestSyncAction} success={t('connections.detail.syncRequested')}>
            <ActionButton pendingLabel={t('connections.detail.syncing')}>{t('connections.detail.syncNow')}</ActionButton>
            <input type="hidden" name="connectionId" value={connection.id} />
          </ActionForm>
        }
      >
        {connection.syncStates.length === 0 ? (
          <EmptyState>{t('connections.detail.syncEmpty')}</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th scope="col" className={thClass}>{t('connections.detail.syncColumns.data')}</th>
                  <th scope="col" className={thClass}>{t('connections.detail.syncColumns.started')}</th>
                  <th scope="col" className={thClass}>{t('connections.detail.syncColumns.finished')}</th>
                  <th scope="col" className={thClass}>{t('connections.detail.syncColumns.lastSuccess')}</th>
                  <th scope="col" className={thClass}>{t('connections.detail.syncColumns.result')}</th>
                  <th scope="col" className={thClass}>{t('connections.detail.syncColumns.error')}</th>
                </tr>
              </thead>
              <tbody>
                {connection.syncStates.map((state) => (
                  <tr key={state.stream} className={rowClass}>
                    <th scope="row" className={`${tdClass} font-medium`}>{streamLabel(t, state.stream)}</th>
                    <td className={tdClass}>{time(state.lastStartedAt)}</td>
                    <td className={tdClass}>{isSyncRunning(state) ? t('connections.running') : time(state.lastFinishedAt)}</td>
                    <td className={tdClass}>{time(state.lastSucceededAt)}</td>
                    <td className={tdClass}>{formatSyncResult(state.lastResult, t, locale) ?? '—'}</td>
                    <td className={tdClass}>
                      {state.lastErrorKind ? (
                        <>
                          <span className="font-medium text-red-800">{syncErrorLabel(t, state.lastErrorKind)}</span>
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

      <Section title={t('connections.detail.eventsTitle')}>
        {events.length === 0 ? (
          <EmptyState>{t('connections.detail.eventsEmpty')}</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {events.map((event) => {
              const { title, detail } = describeEvent(event.type, event.payload, t, format)
              return (
                <li key={event.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                  <span>
                    {title}
                    {detail ? <span className="text-muted"> · {detail}</span> : null}
                  </span>
                  <time dateTime={event.createdAt.toISOString()} className="text-muted">
                    {format.dateTime(event.createdAt)}
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
