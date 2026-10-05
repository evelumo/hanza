import { listOrders } from '@hanza/core'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { buttonClass } from '@/components/button-class'
import { Pagination } from '@/components/pagination'
import { EmptyState, linkClass, rowClass, tableClass, tdClass, thClass } from '@/components/section'
import { AttentionBadge, OrderStatusBadge } from '@/components/status-badge'
import { getContext } from '@/lib/context'
import { formatDateTime, formatMoney } from '@/lib/format'
import { orderStatusLabels } from '@/lib/labels'
import { firstParam, outOfRangeRedirect, pageWindow, parsePage } from '@/lib/pagination'
import { requireTenant } from '@/lib/session'
import { orderListFiltersSchema } from './schemas'

export const dynamic = 'force-dynamic'

export default async function OrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { organizationId } = await requireTenant()
  const params = await searchParams
  const filters = orderListFiltersSchema.parse({ status: firstParam(params.status), attention: firstParam(params.attention) })
  const page = parsePage(params.page)
  const { total, items } = await listOrders(getContext(), organizationId, {
    status: filters.status,
    needsAttention: filters.attention === '1' ? true : undefined,
    ...pageWindow(page),
  })
  const outOfRange = outOfRangeRedirect(page, total, '/orders', { status: filters.status, attention: filters.attention })
  if (outOfRange) redirect(outOfRange)
  const filtered = Boolean(filters.status || filters.attention)

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Zamówienia</h1>

      <form method="get" className="flex flex-wrap items-end gap-4">
        <label className="block text-sm font-medium">
          Status
          <select
            name="status"
            defaultValue={filters.status ?? ''}
            className="mt-1 block rounded-md border border-line bg-white px-3 py-1.5 text-sm font-normal outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          >
            <option value="">Wszystkie</option>
            {Object.entries(orderStatusLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm font-medium">
          <input type="checkbox" name="attention" value="1" defaultChecked={filters.attention === '1'} className="size-4 accent-accent" />
          Tylko wymagające uwagi
        </label>
        <button type="submit" className={buttonClass('secondary')}>
          Filtruj
        </button>
        {filtered ? (
          <Link href="/orders" className={buttonClass('secondary')}>
            Wyczyść
          </Link>
        ) : null}
      </form>

      <div className="rounded-lg border border-line bg-white">
        {total === 0 ? (
          <EmptyState>
            {filtered ? 'Żadne zamówienie nie pasuje do filtrów.' : 'Nie ma jeszcze zamówień. Pojawią się po synchronizacji połączenia z kanałem.'}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th scope="col" className={thClass}>Numer</th>
                  <th scope="col" className={thClass}>Kanał</th>
                  <th scope="col" className={thClass}>Data</th>
                  <th scope="col" className={thClass}>Kupujący</th>
                  <th scope="col" className={`${thClass} text-right`}>Kwota</th>
                  <th scope="col" className={thClass}>Status</th>
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
                    <td className={tdClass}>{formatDateTime(order.placedAt)}</td>
                    <td className={tdClass}>{order.buyerName}</td>
                    <td className={`${tdClass} text-right tabular-nums`}>{formatMoney(order.total)}</td>
                    <td className={tdClass}>
                      <span className="flex flex-wrap gap-1.5">
                        <OrderStatusBadge status={order.status} />
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

      <Pagination page={page} total={total} basePath="/orders" params={{ status: filters.status, attention: filters.attention }} />
    </div>
  )
}
