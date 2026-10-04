import { getProduct } from '@hanza/core'
import Link from 'next/link'
import { ActionForm } from '@/components/action-form'
import { ActionButton } from '@/components/form'
import { EmptyState, Section, linkClass, rowClass, tableClass, tdClass, thClass } from '@/components/section'
import { getContext } from '@/lib/context'
import { formatDateTime } from '@/lib/format'
import { requireTenant } from '@/lib/session'
import { notFound } from 'next/navigation'
import { unlinkOfferAction } from './actions'
import { NameForm } from './name-form'
import { StockForm } from './stock-form'

export const dynamic = 'force-dynamic'

function Figure({ label, value, negative }: { label: string; value: number; negative?: boolean }) {
  return (
    <div className="rounded-lg border border-line bg-white px-5 py-4">
      <p className="text-sm text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${negative ? 'text-red-700' : ''}`}>{value}</p>
      {negative ? <p className="text-xs font-medium text-red-700">Brak towaru: sprzedano więcej, niż jest na stanie.</p> : null}
    </div>
  )
}

export default async function ProductPage({ params }: { params: Promise<{ productId: string }> }) {
  const { organizationId } = await requireTenant()
  const { productId } = await params
  const product = await getProduct(getContext(), organizationId, productId)
  if (!product) notFound()

  return (
    <div className="space-y-6">
      <div>
        <Link href="/products" className={linkClass}>
          ← Produkty
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{product.name}</h1>
        <p className="font-mono text-sm text-muted">SKU: {product.sku}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Figure label="Stan" value={product.stock} />
        <Figure label="Zarezerwowane" value={product.reserved} />
        <Figure label="Dostępne" value={product.available} negative={product.available < 0} />
      </div>

      <Section title="Dane produktu" description="SKU jest stałe i nie można go zmienić.">
        <div className="px-5 py-4">
          <NameForm productId={product.id} name={product.name} />
        </div>
      </Section>

      <Section title="Stan" description="Hanza jest źródłem prawdy o stanie. Kanały dostają tylko Dostępne (Stan minus Rezerwacje).">
        <div className="px-5 py-4">
          <StockForm productId={product.id} stock={product.stock} />
        </div>
      </Section>

      <Section title="Oferty" description="Oferty tego produktu w kanałach.">
        {product.offers.length === 0 ? (
          <EmptyState>Ten produkt nie ma jeszcze połączonych ofert. Oferta łączy się automatycznie po SKU albo ręcznie na liście ofert bez produktu.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th scope="col" className={thClass}>Połączenie</th>
                  <th scope="col" className={thClass}>Oferta</th>
                  <th scope="col" className={thClass}>Powiązanie</th>
                  <th scope="col" className={thClass}>Ostatnio wysłano</th>
                  <th scope="col" className={thClass}>
                    <span className="sr-only">Akcje</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {product.offers.map((offer) => (
                  <tr key={offer.id} className={rowClass}>
                    <td className={tdClass}>{offer.connectionName}</td>
                    <td className={tdClass}>
                      {offer.name}
                      <span className="block font-mono text-xs text-muted">{offer.externalId}</span>
                    </td>
                    <td className={tdClass}>{offer.linkedBy === 'manual' ? 'Ręcznie' : 'Po SKU'}</td>
                    <td className={tdClass}>
                      {offer.lastPushedAt ? (
                        <>
                          {offer.lastPushedAvailable} szt.
                          <span className="block text-xs text-muted">{formatDateTime(offer.lastPushedAt)}</span>
                        </>
                      ) : (
                        <span className="text-muted">jeszcze nie wysłano</span>
                      )}
                    </td>
                    <td className={`${tdClass} text-right`}>
                      <ActionForm action={unlinkOfferAction} confirm="Rozłączyć ofertę z tym produktem? Kanał nie dostanie już jego stanu.">
                        <input type="hidden" name="offerId" value={offer.id} />
                        <ActionButton variant="secondary" pendingLabel="Rozłączanie…">
                          Rozłącz
                        </ActionButton>
                      </ActionForm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Otwarte rezerwacje" description="Towar obiecany zamówieniom, które jeszcze nie zostały wysłane.">
        {product.openReservations.length === 0 ? (
          <EmptyState>Brak otwartych rezerwacji.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {product.openReservations.map((reservation) => (
              <li key={`${reservation.orderId}-${reservation.createdAt.toISOString()}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                <Link href={`/orders/${reservation.orderId}`} className={linkClass}>
                  Zamówienie {reservation.orderExternalId}
                </Link>
                <span>
                  {reservation.units} szt. <span className="text-muted">· {formatDateTime(reservation.createdAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}
