import { getOrder } from '@hanza/core'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ActionForm } from '@/components/action-form'
import { ActionButton } from '@/components/form'
import { EmptyState, Section, linkClass, rowClass, tableClass, tdClass, thClass } from '@/components/section'
import { AttentionBadge, OrderStatusBadge } from '@/components/status-badge'
import { getContext } from '@/lib/context'
import { describeEvent } from '@/lib/events'
import { formatDateTime, formatMoney } from '@/lib/format'
import { attentionReasonLabels, factLabels, orderStatusLabels, paymentLabels, reservationLabels } from '@/lib/labels'
import { requireTenant } from '@/lib/session'
import { changeOrderStatusAction, resolveAttentionAction } from './actions'
import { AddressBlock } from './address-block'
import { LinkLineForm } from './link-line-form'

export const dynamic = 'force-dynamic'

const statusConfirm = {
  shipped: 'Oznaczyć zamówienie jako wysłane? Zarezerwowany towar zostanie zdjęty ze stanu.',
  cancelled: 'Anulować zamówienie? Rezerwacje zostaną zwolnione, a tej zmiany nie można cofnąć.',
} as const

export default async function OrderPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { organizationId } = await requireTenant()
  const { orderId } = await params
  const order = await getOrder(getContext(), organizationId, orderId)
  if (!order) notFound()

  const unmatchedLines = order.lines.filter((line) => !line.productId).length
  const manualReasons = order.attentionReasons.filter((reason) => reason !== 'unmatched_line')

  return (
    <div className="space-y-6">
      <div>
        <Link href="/orders" className={linkClass}>
          ← Zamówienia
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            Zamówienie <span className="font-mono">{order.externalId}</span>
          </h1>
          <OrderStatusBadge status={order.status} />
          {order.attentionReasons.length > 0 ? <AttentionBadge /> : null}
        </div>
        <p className="mt-1 text-sm text-muted">
          Kanał: {order.connectionName} · {formatDateTime(order.placedAt)} · {paymentLabels[order.payment]} · {formatMoney(order.total)}
        </p>
      </div>

      {order.attentionReasons.length > 0 ? (
        <section role="region" aria-label="Wymaga uwagi" className="rounded-lg border border-red-300 bg-red-50 px-5 py-4">
          <h2 className="font-semibold text-red-900">Wymaga uwagi</h2>
          <ul className="mt-2 list-disc pl-5 text-sm text-red-900">
            {order.attentionReasons.map((reason) => (
              <li key={reason}>{attentionReasonLabels[reason]}</li>
            ))}
          </ul>
          {order.attentionReasons.includes('unmatched_line') ? (
            <p className="mt-2 text-sm text-red-900">Połącz niepołączone pozycje z produktami poniżej, a to oznaczenie zniknie samo.</p>
          ) : null}
          {manualReasons.length > 0 ? (
            <ActionForm action={resolveAttentionAction} className="mt-3">
              <input type="hidden" name="orderId" value={order.id} />
              <ActionButton variant="secondary" pendingLabel="Zapisywanie…">
                Oznacz jako sprawdzone
              </ActionButton>
            </ActionForm>
          ) : null}
        </section>
      ) : null}

      <Section title="Status" description="Postęp realizacji prowadzi Hanza; zmiana jest przekazywana do kanału, jeśli kanał to obsługuje.">
        <div className="px-5 py-4">
          {order.allowedTransitions.length === 0 ? (
            <p className="text-sm text-muted">Zamówienie ma status końcowy ({orderStatusLabels[order.status]}), nie można go zmienić.</p>
          ) : (
            <div className="flex flex-wrap gap-3">
              {order.allowedTransitions.map((status) => (
                <ActionForm
                  // A new key after lines get linked drops the stale "link the lines first" error.
                  key={`${status}:${unmatchedLines}`}
                  action={changeOrderStatusAction}
                  confirm={status === 'shipped' || status === 'cancelled' ? statusConfirm[status] : undefined}
                >
                  <input type="hidden" name="orderId" value={order.id} />
                  <input type="hidden" name="status" value={status} />
                  <ActionButton variant={status === 'cancelled' ? 'danger' : 'secondary'} pendingLabel="Zapisywanie…">
                    Zmień na: {orderStatusLabels[status]}
                  </ActionButton>
                </ActionForm>
              ))}
            </div>
          )}
        </div>
      </Section>

      <Section title="Pozycje">
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead>
              <tr>
                <th scope="col" className={thClass}>SKU</th>
                <th scope="col" className={thClass}>Nazwa</th>
                <th scope="col" className={`${thClass} text-right`}>Ilość</th>
                <th scope="col" className={`${thClass} text-right`}>Cena</th>
                <th scope="col" className={thClass}>Produkt</th>
                <th scope="col" className={thClass}>Rezerwacja</th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((line) => (
                <tr key={line.id} className={rowClass}>
                  <td className={`${tdClass} font-mono`}>{line.sku ?? <span className="font-sans text-muted">brak</span>}</td>
                  <td className={tdClass}>{line.name}</td>
                  <td className={`${tdClass} text-right tabular-nums`}>{line.quantity}</td>
                  <td className={`${tdClass} text-right tabular-nums`}>{formatMoney(line.unitPrice)}</td>
                  <td className={tdClass}>
                    {line.productId ? (
                      <Link href={`/products/${line.productId}`} className={linkClass}>
                        {line.productSku}
                      </Link>
                    ) : (
                      <div className="space-y-2">
                        <AttentionBadge label="Niepołączona" />
                        <LinkLineForm lineId={line.id} suggestedSku={line.sku} />
                      </div>
                    )}
                  </td>
                  <td className={tdClass}>
                    <span className="flex flex-wrap items-center gap-1.5">
                      {line.reservationStatus ? reservationLabels[line.reservationStatus] : <span className="text-muted">brak</span>}
                      {line.shortage ? <AttentionBadge label="Brak na stanie" /> : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Kupujący">
        <div className="grid gap-6 px-5 py-4 sm:grid-cols-3">
          <div>
            <h3 className="text-sm font-medium text-muted">Dane kontaktowe</h3>
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
                  tel. {order.buyer.phone}
                </>
              ) : null}
              {order.buyer.login ? (
                <>
                  <br />
                  Login w kanale: {order.buyer.login}
                </>
              ) : null}
            </p>
          </div>
          <AddressBlock title="Adres dostawy" address={order.shippingAddress} />
          <AddressBlock title="Adres do faktury" address={order.billingAddress} />
        </div>
      </Section>

      <Section title="Zmiany zgłoszone przez kanał">
        {order.facts.length === 0 ? (
          <EmptyState>Kanał nie zgłosił żadnych zmian.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {order.facts.map((fact) => (
              <li key={fact.externalId} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                <span>
                  {factLabels[fact.type]}
                  {fact.note ? <span className="text-muted"> · {fact.note}</span> : null}
                </span>
                <time dateTime={fact.occurredAt.toISOString()} className="text-muted">
                  {formatDateTime(fact.occurredAt)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Historia">
        {order.events.length === 0 ? (
          <EmptyState>Brak zdarzeń.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {order.events.map((event) => {
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
