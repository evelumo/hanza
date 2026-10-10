import { deviceFlowOf, isChannel } from '@hanza/connector-sdk'
import {
  canManageOrganization,
  CHANNEL_REPORTED_PHASES,
  getConnection,
  getStatusMapping,
  listEvents,
  listRejectedOffers,
  listOrderStatuses,
  listWarehouses,
} from '@hanza/core'
import { KeyRound } from 'lucide-react'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ActionForm } from '@/components/action-form'
import { DataTable, DataTableBody, DataTableCell, DataTableHead, DataTableHeader, DataTableRow, DataTableRowHeader } from '@/components/data-table'
import { DescriptionItem, DescriptionList } from '@/components/description-list'
import { EmptyState } from '@/components/empty-state'
import { EventTimeline } from '@/components/event-timeline'
import { ActionButton } from '@/components/form'
import { Identifier } from '@/components/identifier'
import { NoValue } from '@/components/no-value'
import { Notice } from '@/components/notice'
import { PageHeader } from '@/components/page-header'
import { Page, PageColumns } from '@/components/page-layout'
import { PushWarning } from '@/components/push-warning'
import { Section, SectionContent } from '@/components/section'
import { HealthBadge } from '@/components/status-badge'
import { TextLink } from '@/components/text-link'
import { getActiveLocale, getT } from '@/i18n/server'
import { getContext } from '@/lib/context'
import { getFormatters } from '@/lib/formatters'
import { labelOrRaw, orderStatusName, reportedPhaseLabel, streamLabel } from '@/lib/labels'
import { rejectionText } from '@/lib/offer-push-status'
import { requireTenant } from '@/lib/session'
import { isSyncRunning } from '@/lib/sync-status'
import { signInAgainAction } from '../actions'
import { SyncStatusBadge } from '../sync-status-badge'
import { formatSyncResult } from '../sync-summary'
import { ChannelWarehousesForm } from './channel-warehouses-form'
import { StatusMappingForm, type MappingRow } from './status-mapping-form'
import { StockRulesForm } from './stock-rules-form'
import { SyncNowButton, SyncRequest, SyncRequestResult } from './sync-request'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('connections.detail.title') }
}

const none = <NoValue />

export default async function ConnectionPage({ params }: { params: Promise<{ connectionId: string }> }) {
  const { user, organizationId } = await requireTenant()
  const [t, format, locale] = await Promise.all([getT(), getFormatters(), getActiveLocale()])
  const time = (date: Date) => (
    <time dateTime={date.toISOString()} className="whitespace-nowrap tabular-nums">
      {format.dateTime(date)}
    </time>
  )
  const { connectionId } = await params
  const ctx = getContext()
  const connection = await getConnection(ctx, organizationId, connectionId)
  if (!connection) notFound()
  const connector = ctx.connectors.get(connection.connectorId)
  const connectorName = connector?.name ?? connection.connectorId
  const canSignIn = connector !== undefined && deviceFlowOf(connector) !== undefined
  const authExpired = connection.health === 'auth_expired'
  const signInAgain = (variant: 'primary' | 'secondary') => (
    <ActionForm action={signInAgainAction} className="grid gap-2">
      <input type="hidden" name="connectionId" value={connection.id} />
      <ActionButton variant={variant} pendingLabel={t('connections.detail.signInAgainStarting')} className="justify-self-start">
        {t('connections.detail.signInAgain')}
      </ActionButton>
    </ActionForm>
  )
  const [events, warehouses, statuses, mapping, canManage, rejectedOffers] = await Promise.all([
    listEvents(ctx, organizationId, { type: 'connection', id: connection.id }, 20),
    listWarehouses(ctx, organizationId),
    listOrderStatuses(ctx, organizationId),
    getStatusMapping(ctx, organizationId, connection.id),
    canManageOrganization(ctx, organizationId, user.id),
    listRejectedOffers(ctx, organizationId, connection.id),
  ])
  const mappingRows: MappingRow[] = CHANNEL_REPORTED_PHASES.map((phase) => {
    const inPhase = statuses.filter((status) => status.phase === phase)
    const defaultStatus = inPhase.find((status) => status.isDefault)
    const current = mapping[phase] ?? ''
    return {
      phase,
      label: reportedPhaseLabel(t, phase),
      defaultLabel: defaultStatus ? orderStatusName(t, defaultStatus) : '',
      current,
      options: inPhase
        .filter((status) => status.active || status.id === current)
        .map((status) => ({ id: status.id, label: orderStatusName(t, status) })),
    }
  })

  return (
    <Page>
      <SyncRequest>
        <PageHeader
          back={{ href: '/connections', label: t('connections.title') }}
          title={connection.name}
          badges={<HealthBadge health={connection.health} />}
          meta={
            <>
              {connectorName}
              {connection.accountLabel ? (
                <>
                  {' · '}
                  <span>{t('connections.detail.account', { account: connection.accountLabel })}</span>
                </>
              ) : null}
            </>
          }
          actions={
            <SyncNowButton
              connectionId={connection.id}
              // While the Connection waits for a sign-in, signing in is the one thing to do; a sync would only fail again.
              variant={canSignIn && authExpired ? 'secondary' : 'primary'}
              label={t('connections.detail.syncNow')}
              pendingLabel={t('connections.detail.syncing')}
            />
          }
        />

        <PageColumns
          aside={
            <>
              <Section title={t('connections.detail.detailsTitle')}>
                <SectionContent className="py-2">
                  <DescriptionList layout="inline">
                    <DescriptionItem term={t('connections.columns.connector')}>{connectorName}</DescriptionItem>
                    {connector ? (
                      <DescriptionItem term={t('connections.detail.kind')}>{labelOrRaw(t, 'labels.connectorKind', connector.kind)}</DescriptionItem>
                    ) : null}
                    {connection.healthChangedAt ? (
                      <DescriptionItem term={t('connections.detail.healthChanged')}>
                        <span className="tabular-nums">{format.dateTime(connection.healthChangedAt)}</span>
                      </DescriptionItem>
                    ) : null}
                    <DescriptionItem term={t('connections.detail.added')}>
                      <span className="tabular-nums">{format.dateTime(connection.createdAt)}</span>
                    </DescriptionItem>
                    <DescriptionItem term={t('connections.detail.connectionId')}>
                      <Identifier wrap>{connection.id}</Identifier>
                    </DescriptionItem>
                  </DescriptionList>
                </SectionContent>
              </Section>

              {canSignIn && !authExpired ? (
                <Section title={t('connections.detail.signInTitle')}>
                  <SectionContent className="grid gap-3">
                    <p className="text-sm text-muted-foreground">{t('connections.detail.signInHint', { connector: connectorName })}</p>
                    {signInAgain('secondary')}
                  </SectionContent>
                </Section>
              ) : null}
            </>
          }
          after={
            <Section title={t('connections.detail.eventsTitle')}>
              {events.length === 0 ? (
                <EmptyState>{t('connections.detail.eventsEmpty')}</EmptyState>
              ) : (
                <EventTimeline events={events} format={format} current={{ type: 'connection', id: connection.id }} />
              )}
            </Section>
          }
        >
          {canSignIn && authExpired ? (
            <Notice tone="warning" icon={KeyRound} title={t('connections.detail.authExpiredTitle')} actions={signInAgain('primary')}>
              {t('connections.detail.authExpired', { connector: connectorName })}
            </Notice>
          ) : null}

          <Section title={t('connections.detail.syncTitle')} description={t('connections.detail.syncDescription')}>
            <SyncRequestResult success={t('connections.detail.syncRequested')} />
            {connection.syncStates.length === 0 ? (
              <EmptyState>{t('connections.detail.syncEmpty')}</EmptyState>
            ) : (
              <DataTable align="top">
                {/* Four columns, of which only the result wraps: the table fits the page's main column without scrolling. */}
                <DataTableHeader>
                  <DataTableHead>{t('connections.detail.syncColumns.data')}</DataTableHead>
                  <DataTableHead>{t('connections.detail.syncColumns.status')}</DataTableHead>
                  <DataTableHead>{t('connections.detail.syncColumns.lastRun')}</DataTableHead>
                  <DataTableHead>{t('connections.detail.syncColumns.result')}</DataTableHead>
                </DataTableHeader>
                <DataTableBody>
                  {connection.syncStates.map((state) => {
                    const running = isSyncRunning(state)
                    const result = formatSyncResult(state.lastResult, t, locale)
                    // A run that succeeded is its own last success; the line is only for a run that was not.
                    const staleSuccess = !running && state.lastFinishedAt?.getTime() !== state.lastSucceededAt?.getTime()
                    return (
                      <DataTableRow key={state.stream}>
                        <DataTableRowHeader narrow="primary" className="whitespace-nowrap">
                          {streamLabel(t, state.stream)}
                        </DataTableRowHeader>
                        <DataTableCell narrow="end">
                          <SyncStatusBadge state={state} />
                        </DataTableCell>
                        <DataTableCell narrowLabel={t('connections.detail.syncColumns.lastRun')}>
                          {running && state.lastStartedAt ? (
                            <>
                              <span className="text-muted-foreground">{t('connections.detail.syncColumns.started')}</span> {time(state.lastStartedAt)}
                            </>
                          ) : state.lastFinishedAt ? (
                            time(state.lastFinishedAt)
                          ) : (
                            none
                          )}
                          {staleSuccess && state.lastSucceededAt ? (
                            <span className="mt-0.5 block text-meta text-muted-foreground">
                              {t('connections.detail.syncColumns.lastSuccess')} {time(state.lastSucceededAt)}
                            </span>
                          ) : null}
                        </DataTableCell>
                        <DataTableCell narrowLabel={t('connections.detail.syncColumns.result')} className="break-words @2xl/table:min-w-40">
                          {result ?? (state.lastError ? null : none)}
                          {/* What the last run failed with, in the Channel's or the connector's own words. */}
                          {state.lastError ? <p className="text-meta text-muted-foreground">{state.lastError}</p> : null}
                        </DataTableCell>
                      </DataTableRow>
                    )
                  })}
                </DataTableBody>
              </DataTable>
            )}
          </Section>

          {rejectedOffers.length > 0 ? (
            <Section title={t('connections.detail.rejectedTitle')} description={t('connections.detail.rejectedDescription')}>
              <DataTable align="top">
                <DataTableHeader>
                  <DataTableHead>{t('connections.detail.rejectedColumns.offer')}</DataTableHead>
                  <DataTableHead>{t('connections.detail.rejectedColumns.stock')}</DataTableHead>
                  <DataTableHead>{t('connections.detail.rejectedColumns.price')}</DataTableHead>
                </DataTableHeader>
                <DataTableBody>
                  {rejectedOffers.map((offer) => (
                    <DataTableRow key={offer.id}>
                      <DataTableRowHeader narrow="primary" className="font-normal">
                        <TextLink href={`/products/offers/${offer.id}`}>{offer.name}</TextLink>
                        <Identifier className="block text-muted-foreground">{offer.externalId}</Identifier>
                      </DataTableRowHeader>
                      {[offer.stockRejection, offer.priceRejection].map((rejection, index) => (
                        <DataTableCell key={index} narrowLabel={t(index === 0 ? 'connections.detail.rejectedColumns.stock' : 'connections.detail.rejectedColumns.price')}>
                          {rejection ? (
                            <PushWarning>
                              {rejectionText(t, rejection)}
                              <time dateTime={rejection.at.toISOString()} className="block text-xs font-normal text-muted-foreground tabular-nums">
                                {format.dateTime(rejection.at)}
                              </time>
                            </PushWarning>
                          ) : (
                            none
                          )}
                        </DataTableCell>
                      ))}
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>
            </Section>
          ) : null}

          {connector && isChannel(connector) ? (
            <>
              <Section title={t('connections.stockRules.title')} description={t('connections.stockRules.description')}>
                <SectionContent>
                  <StockRulesForm
                    connectionId={connection.id}
                    safetyBuffer={connection.stockRules.safetyBuffer}
                    channelLimit={connection.stockRules.channelLimit}
                  />
                </SectionContent>
              </Section>
              <Section title={t('connections.warehouses.title')} description={t('connections.warehouses.description')}>
                <SectionContent>
                  <ChannelWarehousesForm
                    connectionId={connection.id}
                    all={connection.warehouses.all}
                    chosen={connection.warehouses.warehouseIds}
                    warehouses={warehouses.filter((warehouse) => warehouse.active).map(({ id, name }) => ({ id, name }))}
                  />
                </SectionContent>
              </Section>
              <Section title={t('connections.detail.statusMapping.title')} description={t('connections.detail.statusMapping.description')}>
                <SectionContent className="grid gap-4">
                  {canManage ? null : <Notice tone="neutral">{t('connections.detail.statusMapping.adminsOnly')}</Notice>}
                  <StatusMappingForm connectionId={connection.id} rows={mappingRows} disabled={!canManage} />
                </SectionContent>
              </Section>
            </>
          ) : null}
        </PageColumns>
      </SyncRequest>
    </Page>
  )
}
