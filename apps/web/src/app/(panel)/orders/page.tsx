import { orderStatusSchema } from '@hanza/connector-sdk'
import { listOrders } from '@hanza/core'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { buttonClass } from '@/components/button-class'
import { Pagination } from '@/components/pagination'
import { EmptyState, linkClass, rowClass, tableClass, tdClass, thClass } from '@/components/section'
import { AttentionBadge, AwaitingPaymentBadge, OrderStatusBadge } from '@/components/status-badge'
import { getT } from '@/i18n/server'
import { getContext } from '@/lib/context'
import { getFormatters } from '@/lib/formatters'
import { orderStatusLabel } from '@/lib/labels'
import { showsAwaitingPayment } from '@/lib/payment'
import { firstParam, outOfRangeRedirect, pageWindow, parsePage } from '@/lib/pagination'
import { requireTenant } from '@/lib/session'
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
    status: firstParam(params.status),
    attention: firstParam(params.attention),
    payment: firstParam(params.payment),
  })
  const filterParams = { status: filters.status, attention: filters.attention, payment: filters.payment }
  const page = parsePage(params.page)
  const { total, items } = await listOrders(getContext(), organizationId, {
    status: filters.status,
    needsAttention: filters.attention === '1' ? true : undefined,
    awaitingPayment: filters.payment === 'awaiting' ? true : undefined,
    ...pageWindow(page),
  })
  const outOfRange = outOfRangeRedirect(page, total, '/orders', filterParams)
  if (outOfRange) redirect(outOfRange)
  const filtered = Boolean(filters.status || filters.attention || filters.payment)

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('orders.title')}</h1>

      <form method="get" className="flex flex-wrap items-end gap-4">
        <label className="block text-sm font-medium">
          {t('orders.filters.status')}
          <select
            name="status"
            defaultValue={filters.status ?? ''}
            className="mt-1 block rounded-md border border-line bg-white px-3 py-1.5 text-sm font-normal outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          >
            <option value="">{t('orders.filters.all')}</option>
            {orderStatusSchema.options.map((value) => (
              <option key={value} value={value}>
                {orderStatusLabel(t, value)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm font-medium">
          <input type="checkbox" name="attention" value="1" defaultChecked={filters.attention === '1'} className="size-4 accent-accent" />
          {t('orders.filters.attentionOnly')}
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm font-medium">
          <input type="checkbox" name="payment" value="awaiting" defaultChecked={filters.payment === 'awaiting'} className="size-4 accent-accent" />
          {t('orders.filters.awaitingPaymentOnly')}
        </label>
        <button type="submit" className={buttonClass('secondary')}>
          {t('orders.filters.apply')}
        </button>
        {filtered ? (
          <Link href="/orders" className={buttonClass('secondary')}>
            {t('orders.filters.clear')}
          </Link>
        ) : null}
      </form>

      <div className="rounded-lg border border-line bg-white">
        {total === 0 ? (
          <EmptyState>
            {filtered ? t('orders.emptyFiltered') : t('orders.empty')}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th scope="col" className={thClass}>{t('orders.columns.number')}</th>
                  <th scope="col" className={thClass}>{t('orders.columns.channel')}</th>
                  <th scope="col" className={thClass}>{t('orders.columns.date')}</th>
                  <th scope="col" className={thClass}>{t('orders.columns.buyer')}</th>
                  <th scope="col" className={`${thClass} text-right`}>{t('orders.columns.total')}</th>
                  <th scope="col" className={thClass}>{t('orders.columns.status')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((order) => (
                  <tr key={order.id} className={rowClass}>
                    <td className={`${tdClass} font-mono`}>
                      <Link href={`/orders/${order.id}`} className={linkClass}>
                        {order.externalId}
                      </Link>
                    </td>
                    <td className={tdClass}>{order.connectionName}</td>
                    <td className={tdClass}>{format.dateTime(order.placedAt)}</td>
                    <td className={tdClass}>
                      {order.buyerName ?? (
                        <span className={order.buyerDataState === 'unreadable' ? 'text-red-800' : 'text-muted'}>
                          {order.buyerDataState === 'unreadable' ? t('orders.buyerUnreadable') : t('orders.buyerErased')}
                        </span>
                      )}
                    </td>
                    <td className={`${tdClass} text-right tabular-nums`}>{format.money(order.total)}</td>
                    <td className={tdClass}>
                      <span className="flex flex-wrap gap-1.5">
                        <OrderStatusBadge status={order.status} />
                        {showsAwaitingPayment(order) ? <AwaitingPaymentBadge /> : null}
                        {order.attentionReasons.length > 0 ? <AttentionBadge /> : null}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Pagination page={page} total={total} basePath="/orders" params={filterParams} />
    </div>
  )
}
