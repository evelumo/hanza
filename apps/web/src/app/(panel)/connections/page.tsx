import { listConnections } from '@hanza/core'
import { Cable } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { buttonClass } from '@/components/button-class'
import { DataTable, DataTableBody, DataTableCell, DataTableHead, DataTableHeader, DataTableLinkRow, DataTableMeta, DataTableMetaItem } from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { Page } from '@/components/page-layout'
import { Panel } from '@/components/section'
import { HealthBadge } from '@/components/status-badge'
import { TextLink } from '@/components/text-link'
import { getActiveLocale, getT } from '@/i18n/server'
import { getContext } from '@/lib/context'
import { getFormatters } from '@/lib/formatters'
import { streamLabel } from '@/lib/labels'
import { requireTenant } from '@/lib/session'
import { isSyncRunning } from '@/lib/sync-status'
import { SyncErrorText } from './sync-status-badge'
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
    <Page>
      <PageHeader
        title={t('connections.title')}
        actions={
          <Link href="/connections/new" className={buttonClass('primary')}>
            {t('connections.add')}
          </Link>
        }
      />

      <Panel>
        {connections.length === 0 ? (
          <EmptyState
            icon={Cable}
            title={t('connections.emptyTitle')}
            action={
              <Link href="/connections/new" className={buttonClass('secondary')}>
                {t('connections.add')}
              </Link>
            }
          >
            {t('connections.empty')}
          </EmptyState>
        ) : (
          <DataTable align="top">
            <DataTableHeader>
              <DataTableHead>{t('connections.columns.name')}</DataTableHead>
              <DataTableHead hide="medium">{t('connections.columns.connector')}</DataTableHead>
              <DataTableHead>{t('connections.columns.health')}</DataTableHead>
              <DataTableHead>{t('connections.columns.lastSync')}</DataTableHead>
            </DataTableHeader>
            <DataTableBody>
              {connections.map((connection) => (
                <DataTableLinkRow key={connection.id} href={`/connections/${connection.id}`}>
                  <DataTableCell narrow="primary">
                    <TextLink href={`/connections/${connection.id}`}>{connection.name}</TextLink>
                    <DataTableMeta below="medium">
                      <DataTableMetaItem label={t('connections.columns.connector')} labelHidden>
                        {ctx.connectors.get(connection.connectorId)?.name ?? connection.connectorId}
                      </DataTableMetaItem>
                      {connection.accountLabel}
                    </DataTableMeta>
                  </DataTableCell>
                  <DataTableCell hide="medium">
                    <span className="block whitespace-nowrap">{ctx.connectors.get(connection.connectorId)?.name ?? connection.connectorId}</span>
                    {connection.accountLabel ? <span className="block text-meta text-muted-foreground">{connection.accountLabel}</span> : null}
                  </DataTableCell>
                  <DataTableCell narrow="end">
                    <HealthBadge health={connection.health} />
                  </DataTableCell>
                  {/* On a narrow container it has the row's whole width and no label: each line names its own kind of data. */}
                  <DataTableCell className="@4xl/table:min-w-72">
                    {connection.syncStates.length === 0 ? (
                      <span className="text-muted-foreground">{t('connections.syncStatus.notRun')}</span>
                    ) : (
                      // One line per kind of data: when it last worked and what it did, or why it did not.
                      <ul className="grid gap-1 text-meta">
                        {connection.syncStates.map((state) => {
                          const result = formatSyncResult(state.lastResult, t, locale)
                          return (
                            <li key={state.stream} className="flex gap-3">
                              <span className="w-32 shrink-0 text-muted-foreground @max-2xl/table:w-24">{streamLabel(t, state.stream)}</span>
                              {state.lastErrorKind ? (
                                <SyncErrorText kind={state.lastErrorKind} />
                              ) : state.lastSucceededAt ? (
                                <span className="min-w-0">
                                  <span className="whitespace-nowrap tabular-nums">{format.dateTime(state.lastSucceededAt)}</span>
                                  {result ? <span className="text-muted-foreground"> · {result}</span> : null}
                                </span>
                              ) : (
                                <span className="text-muted-foreground">
                                  {isSyncRunning(state)
                                    ? t('connections.syncStatus.running')
                                    : state.lastFinishedAt
                                      ? t('connections.syncStatus.nothingToSend')
                                      : t('connections.syncStatus.notRun')}
                                </span>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </DataTableCell>
                </DataTableLinkRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
      </Panel>
    </Page>
  )
}
