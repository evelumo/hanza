import { listOrders, listOrderStatusOptions, ORDER_PHASES } from '@hanza/core'
import { Eraser, OctagonAlert, SearchX, ShoppingCart } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { buttonClass } from '@/components/button-class'
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableLinkRow,
  DataTableMeta,
  DataTableMetaItem,
} from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import { FilterBar, FilterChip, FilterClear, FilterForm, FilterSelect, FilterTabs } from '@/components/filter-bar'
import { PageHeader } from '@/components/page-header'
import { Page } from '@/components/page-layout'
import { Pagination } from '@/components/pagination'
import { Panel } from '@/components/section'
import { AttentionBadge, AwaitingPaymentBadge, OrderStatusBadge } from '@/components/status-badge'
import { orderNumberClass, TextLink } from '@/components/text-link'
import { Button } from '@/components/ui/button'
import { getT } from '@/i18n/server'
import { getContext } from '@/lib/context'
import { getFormatters } from '@/lib/formatters'
import { orderPhaseLabel, orderStatusName } from '@/lib/labels'
import { showsAwaitingPayment } from '@/lib/payment'
import { firstParam, outOfRangeRedirect, pageHref, pageWindow, parsePage } from '@/lib/pagination'
import { requireTenant } from '@/lib/session'
import { cn } from '@/lib/utils'
import { orderListFiltersSchema } from './schemas'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('orders.title') }
}

export default async function OrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { organizationId } = await requireTenant()
  const [t, format] = await Promise.all([getT(), getFormatters()])
  const params = await searchParams
  const filters = orderListFiltersSchema.parse({
    phase: firstParam(params.phase),
    status: firstParam(params.status),
    attention: firstParam(params.attention),
    payment: firstParam(params.payment),
  })
  const page = parsePage(params.page)
  const ctx = getContext()
  const [{ total, items }, statuses] = await Promise.all([
    listOrders(ctx, organizationId, {
      phase: filters.phase,
      statusId: filters.status,
      needsAttention: filters.attention === '1' ? true : undefined,
      awaitingPayment: filters.payment === 'awaiting' ? true : undefined,
      ...pageWindow(page),
    }),
    listOrderStatusOptions(ctx, organizationId),
  ])
  const filterParams = { phase: filters.phase, status: filters.status, attention: filters.attention, payment: filters.payment }
  const outOfRange = outOfRangeRedirect(page, total, '/orders', filterParams)
  if (outOfRange) redirect(outOfRange)
  const filtered = Boolean(filters.phase || filters.status || filters.attention || filters.payment)
  // Every filter is a link to the same list with one parameter changed, back on page 1.
  const withFilters = (change: Partial<typeof filterParams>) => pageHref('/orders', { ...filterParams, ...change }, 1)
  // A status belongs to one phase, so choosing a phase drops the status and choosing a status drops the phase.
  // The list is then within that status's phase, and its tab is the current one, not "All".
  const currentPhase = filters.phase ?? statuses.find((status) => status.id === filters.status)?.phase
  const phaseTab = (phase: (typeof ORDER_PHASES)[number] | undefined, label: string) => ({
    href: withFilters({ phase, status: undefined }),
    label,
    active: phase === undefined ? !filters.phase && !filters.status : currentPhase === phase,
  })

  return (
    <Page>
      <PageHeader title={t('orders.title')} />

      <Panel>
        {total > 0 || filtered ? (
          <FilterBar>
            <FilterTabs
              label={t('orders.filters.phase')}
              tabs={[phaseTab(undefined, t('orders.filters.all')), ...ORDER_PHASES.map((phase) => phaseTab(phase, orderPhaseLabel(t, phase)))]}
            />
            <div className="flex flex-wrap items-center gap-2">
              <FilterChip href={withFilters({ attention: filters.attention ? undefined : '1' })} active={filters.attention === '1'}>
                {t('orders.needsAttention')}
              </FilterChip>
              <FilterChip href={withFilters({ payment: filters.payment ? undefined : 'awaiting' })} active={filters.payment === 'awaiting'}>
                {t('orders.awaitingPayment')}
              </FilterChip>
            </div>
            <FilterForm action="/orders" params={{ attention: filters.attention, payment: filters.payment }}>
              <FilterSelect name="status" label={t('orders.filters.status')} defaultValue={filters.status ?? ''}>
                <option value="">{t('orders.filters.all')}</option>
                {ORDER_PHASES.map((phase) => (
                  <optgroup key={phase} label={orderPhaseLabel(t, phase)}>
                    {statuses
                      .filter((status) => status.phase === phase)
                      .map((status) => (
                        <option key={status.id} value={status.id}>
                          {orderStatusName(t, status)}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </FilterSelect>
              <Button type="submit" variant="outline" size="sm">
                {t('orders.filters.apply')}
              </Button>
            </FilterForm>
            {filtered ? <FilterClear href="/orders" /> : null}
          </FilterBar>
        ) : null}

        {total === 0 ? (
          filtered ? (
            <EmptyState
              icon={SearchX}
              title={t('orders.emptyFilteredTitle')}
              action={
                <Link href="/orders" className={buttonClass('secondary')}>
                  {t('common.clearFilters')}
                </Link>
              }
            >
              {t('orders.emptyFiltered')}
            </EmptyState>
          ) : (
            <EmptyState
              icon={ShoppingCart}
              title={t('orders.emptyTitle')}
              action={
                <Link href="/connections" className={buttonClass('secondary')}>
                  {t('orders.emptyAction')}
                </Link>
              }
            >
              {t('orders.empty')}
            </EmptyState>
          )
        ) : (
          <DataTable>
            <DataTableHeader>
              <DataTableHead>{t('orders.columns.number')}</DataTableHead>
              <DataTableHead hide="medium">{t('orders.columns.channel')}</DataTableHead>
              <DataTableHead hide="medium">{t('orders.columns.date')}</DataTableHead>
              <DataTableHead hide="medium">{t('orders.columns.buyer')}</DataTableHead>
              <DataTableHead numeric>{t('orders.columns.total')}</DataTableHead>
              <DataTableHead>{t('orders.columns.status')}</DataTableHead>
            </DataTableHeader>
            <DataTableBody>
              {items.map((order) => {
                const buyer =
                  order.buyerName ??
                  (order.buyerDataState === 'unreadable' ? (
                    <span className="inline-flex items-center gap-1 text-critical">
                      <OctagonAlert className="size-3.5 shrink-0" aria-hidden="true" />
                      {t('orders.buyerUnreadable')}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                      <Eraser className="size-3.5 shrink-0" aria-hidden="true" />
                      {t('orders.buyerErased')}
                    </span>
                  ))
                return (
                  <DataTableLinkRow key={order.id} href={`/orders/${order.id}`}>
                    <DataTableCell narrow="primary">
                      <TextLink href={`/orders/${order.id}`} className={cn(orderNumberClass, 'whitespace-nowrap')}>
                        {order.externalId}
                      </TextLink>
                      <DataTableMeta below="medium">
                        <DataTableMetaItem label={t('orders.columns.date')} labelHidden>
                          <span className="whitespace-nowrap tabular-nums">{format.dateTime(order.placedAt)}</span>
                        </DataTableMetaItem>
                        <DataTableMetaItem label={t('orders.columns.channel')} labelHidden>
                          {order.connectionName}
                        </DataTableMetaItem>
                        <DataTableMetaItem label={t('orders.columns.buyer')} labelHidden>
                          {buyer}
                        </DataTableMetaItem>
                      </DataTableMeta>
                    </DataTableCell>
                    <DataTableCell hide="medium">{order.connectionName}</DataTableCell>
                    <DataTableCell hide="medium" tabular>
                      {format.dateTime(order.placedAt)}
                    </DataTableCell>
                    <DataTableCell hide="medium">{buyer}</DataTableCell>
                    <DataTableCell numeric narrow="end">
                      {format.money(order.total)}
                    </DataTableCell>
                    <DataTableCell>
                      <span className="flex flex-wrap gap-1.5">
                        <OrderStatusBadge status={order.status} />
                        {showsAwaitingPayment(order) ? <AwaitingPaymentBadge /> : null}
                        {order.attentionReasons.length > 0 ? <AttentionBadge /> : null}
                      </span>
                    </DataTableCell>
                  </DataTableLinkRow>
                )
              })}
            </DataTableBody>
          </DataTable>
        )}
      </Panel>

      {total > 0 ? <Pagination page={page} total={total} basePath="/orders" params={filterParams} /> : null}
    </Page>
  )
}
