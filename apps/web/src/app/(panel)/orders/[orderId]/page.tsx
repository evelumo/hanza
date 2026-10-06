import { getOrder, listWarehouses } from '@hanza/core'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ActionForm } from '@/components/action-form'
import { ActionButton } from '@/components/form'
import { EmptyState, Section, linkClass, rowClass, tableClass, tdClass, thClass } from '@/components/section'
import { AttentionBadge, AwaitingPaymentBadge, OrderStatusBadge } from '@/components/status-badge'
import { getT } from '@/i18n/server'
import { getContext } from '@/lib/context'
import { describeEvent } from '@/lib/events'
import { getFormatters } from '@/lib/formatters'
import { attentionReasonLabel, factLabel, orderStatusLabel, paymentLabel, reservationLabel } from '@/lib/labels'
import { showsAwaitingPayment } from '@/lib/payment'
import { requireTenant } from '@/lib/session'
import { changeOrderStatusAction, resolveAttentionAction } from './actions'
import { AddressBlock } from './address-block'
import { LinkLineForm } from './link-line-form'
import { MoveReservationForm } from './move-reservation-form'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('orders.detail.title') }
}

export default async function OrderPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { organizationId } = await requireTenant()
  const [t, format] = await Promise.all([getT(), getFormatters()])
  const { orderId } = await params
  const ctx = getContext()
  const order = await getOrder(ctx, organizationId, orderId)
  if (!order) notFound()
  const orderOpen = order.status === 'new' || order.status === 'processing'
  const activeWarehouses = orderOpen
    ? (await listWarehouses(ctx, organizationId)).filter((warehouse) => warehouse.active).map(({ id, name }) => ({ id, name }))
    : []

  const unmatchedLines = order.lines.filter((line) => !line.productId).length
  const awaitingPayment = showsAwaitingPayment(order)
  const manualReasons = order.attentionReasons.filter((reason) => reason !== 'unmatched_line')

  return (
    <div className="space-y-6">
      <div>
        <Link href="/orders" className={linkClass}>
          ← {t('orders.title')}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('orders.detail.title')} <span className="font-mono">{order.externalId}</span>
          </h1>
          <OrderStatusBadge status={order.status} />
          {awaitingPayment ? <AwaitingPaymentBadge /> : null}
          {order.attentionReasons.length > 0 ? <AttentionBadge /> : null}
        </div>
        <p className="mt-1 text-sm text-muted">
          {t('orders.detail.summary', {
            channel: order.connectionName,
            date: format.dateTime(order.placedAt),
            payment: paymentLabel(t, order.payment),
            total: format.money(order.total),
          })}
        </p>
      </div>

      {order.attentionReasons.length > 0 ? (
        <section role="region" aria-label={t('orders.needsAttention')} className="rounded-lg border border-red-300 bg-red-50 px-5 py-4">
          <h2 className="font-semibold text-red-900">{t('orders.needsAttention')}</h2>
          <ul className="mt-2 list-disc pl-5 text-sm text-red-900">
            {order.attentionReasons.map((reason) => (
              <li key={reason}>{attentionReasonLabel(t, reason)}</li>
            ))}
          </ul>
          {order.attentionReasons.includes('unmatched_line') ? (
            <p className="mt-2 text-sm text-red-900">{t('orders.detail.attentionHint')}</p>
          ) : null}
          {manualReasons.length > 0 ? (
            <ActionForm action={resolveAttentionAction} className="mt-3">
              <input type="hidden" name="orderId" value={order.id} />
              <ActionButton variant="secondary" pendingLabel={t('common.saving')}>
                {t('orders.detail.markReviewed')}
              </ActionButton>
            </ActionForm>
          ) : null}
        </section>
      ) : null}

      <Section title={t('orders.detail.statusTitle')} description={t('orders.detail.statusDescription')}>
        <div className="space-y-3 px-5 py-4">
          {awaitingPayment ? (
            <p className="text-sm text-amber-900">
              {order.status === 'shipped' ? t('orders.detail.awaitingPaymentShippedHint') : t('orders.detail.awaitingPaymentHint')}
            </p>
          ) : null}
          {order.allowedTransitions.length === 0 ? (
            <p className="text-sm text-muted">{t('orders.detail.finalStatus', { status: orderStatusLabel(t, order.status) })}</p>
          ) : (
            <div className="flex flex-wrap gap-3">
              {order.allowedTransitions.map((status) => (
                <ActionForm
                  // A new key after lines get linked drops the stale "link the lines first" error.
                  key={`${status}:${unmatchedLines}`}
                  action={changeOrderStatusAction}
                  confirm={
                    status === 'shipped'
                      ? t('orders.detail.confirmShipped')
                      : status === 'cancelled'
                        ? t('orders.detail.confirmCancelled')
                        : undefined
                  }
                >
                  <input type="hidden" name="orderId" value={order.id} />
                  <input type="hidden" name="status" value={status} />
                  <ActionButton variant={status === 'cancelled' ? 'danger' : 'secondary'} pendingLabel={t('common.saving')}>
                    {t('orders.detail.changeTo', { status: orderStatusLabel(t, status) })}
                  </ActionButton>
                </ActionForm>
              ))}
            </div>
          )}
        </div>
      </Section>

      <Section title={t('orders.detail.linesTitle')}>
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead>
              <tr>
                <th scope="col" className={thClass}>{t('orders.detail.lineColumns.sku')}</th>
                <th scope="col" className={thClass}>{t('orders.detail.lineColumns.name')}</th>
                <th scope="col" className={`${thClass} text-right`}>{t('orders.detail.lineColumns.quantity')}</th>
                <th scope="col" className={`${thClass} text-right`}>{t('orders.detail.lineColumns.price')}</th>
                <th scope="col" className={thClass}>{t('orders.detail.lineColumns.product')}</th>
                <th scope="col" className={thClass}>{t('orders.detail.lineColumns.reservation')}</th>
                <th scope="col" className={thClass}>{t('orders.detail.lineColumns.warehouse')}</th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((line) => (
                <tr key={line.id} className={rowClass}>
                  <td className={`${tdClass} font-mono`}>{line.sku ?? <span className="font-sans text-muted">{t('common.none')}</span>}</td>
                  <td className={tdClass}>{line.name}</td>
                  <td className={`${tdClass} text-right tabular-nums`}>{format.number(line.quantity)}</td>
                  <td className={`${tdClass} text-right tabular-nums`}>{format.money(line.unitPrice)}</td>
                  <td className={tdClass}>
                    {line.productId ? (
                      <Link href={`/products/${line.productId}`} className={linkClass}>
                        {line.productSku}
                      </Link>
                    ) : (
                      <div className="space-y-2">
                        <AttentionBadge label={t('orders.detail.unmatched')} />
                        <LinkLineForm lineId={line.id} suggestedSku={line.sku} />
                      </div>
                    )}
                  </td>
                  <td className={tdClass}>
                    <span className="flex flex-wrap items-center gap-1.5">
                      {line.reservationStatus ? reservationLabel(t, line.reservationStatus) : <span className="text-muted">{t('common.none')}</span>}
                      {line.shortage ? <AttentionBadge label={t('orders.detail.shortage')} /> : null}
                    </span>
                  </td>
                  <td className={tdClass}>
                    {line.reservationWarehouse ? (
                      <div className="space-y-2">
                        <span>{line.reservationWarehouse.name}</span>
                        {orderOpen && line.reservationStatus === 'open' && activeWarehouses.length > 1 ? (
                          <MoveReservationForm
                            lineId={line.id}
                            targets={activeWarehouses.filter((warehouse) => warehouse.id !== line.reservationWarehouse?.id)}
                          />
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-muted">{t('common.none')}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title={t('orders.detail.buyerTitle')}>
        {order.buyer === null ? (
          <div className="space-y-1 px-5 py-4 text-sm">
            {order.buyerDataState === 'unreadable' ? (
              <p role="alert" className="text-red-800">
                {t('orders.detail.buyerUnreadable')}
              </p>
            ) : (
              <p>{order.buyerDataErasedAt ? t('orders.detail.buyerErased', { date: format.dateTime(order.buyerDataErasedAt) }) : null}</p>
            )}
            {order.shippingCountryCode ? (
              <p className="text-muted">{t('orders.detail.shippingCountry', { country: order.shippingCountryCode })}</p>
            ) : null}
          </div>
        ) : (
          <div className="grid gap-6 px-5 py-4 sm:grid-cols-3">
            <div>
              <h3 className="text-sm font-medium text-muted">{t('orders.detail.contact')}</h3>
              <p className="mt-1 text-sm leading-6">
                {order.buyer.name}
                {order.buyer.email ? (
                  <>
                    <br />
                    {order.buyer.email}
                  </>
                ) : null}
                {order.buyer.phone ? (
                  <>
                    <br />
                    {t('orders.detail.phone', { phone: order.buyer.phone })}
                  </>
                ) : null}
                {order.buyer.login ? (
                  <>
                    <br />
                    {t('orders.detail.channelLogin', { login: order.buyer.login })}
                  </>
                ) : null}
              </p>
            </div>
            <AddressBlock title={t('orders.detail.shippingAddress')} address={order.shippingAddress} />
            <AddressBlock title={t('orders.detail.billingAddress')} address={order.billingAddress} />
          </div>
        )}
      </Section>

      <Section title={t('orders.detail.factsTitle')}>
        {order.facts.length === 0 ? (
          <EmptyState>{t('orders.detail.factsEmpty')}</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {order.facts.map((fact) => (
              <li key={fact.externalId} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                <span>
                  {factLabel(t, fact.type)}
                  {fact.note ? <span className="text-muted"> · {fact.note}</span> : null}
                </span>
                <time dateTime={fact.occurredAt.toISOString()} className="text-muted">
                  {format.dateTime(fact.occurredAt)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t('orders.detail.historyTitle')}>
        {order.events.length === 0 ? (
          <EmptyState>{t('orders.detail.historyEmpty')}</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {order.events.map((event) => {
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
