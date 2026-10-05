import { getProduct } from '@hanza/core'
import type { Metadata } from 'next'
import Link from 'next/link'
import { ActionForm } from '@/components/action-form'
import { ActionButton } from '@/components/form'
import { EmptyState, Section, linkClass, rowClass, tableClass, tdClass, thClass } from '@/components/section'
import { getContext } from '@/lib/context'
import { getT } from '@/i18n/server'
import { getFormatters } from '@/lib/formatters'
import { requireTenant } from '@/lib/session'
import { notFound } from 'next/navigation'
import { unlinkOfferAction } from './actions'
import { NameForm } from './name-form'
import { StockForm } from './stock-form'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('products.detail.title') }
}

function Figure({ label, value, negative, note }: { label: string; value: string; negative?: boolean; note?: string }) {
  return (
    <div className="rounded-lg border border-line bg-white px-5 py-4">
      <p className="text-sm text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${negative ? 'text-red-700' : ''}`}>{value}</p>
      {negative && note ? <p className="text-xs font-medium text-red-700">{note}</p> : null}
    </div>
  )
}

export default async function ProductPage({ params }: { params: Promise<{ productId: string }> }) {
  const { organizationId } = await requireTenant()
  const [t, format] = await Promise.all([getT(), getFormatters()])
  const { productId } = await params
  const product = await getProduct(getContext(), organizationId, productId)
  if (!product) notFound()

  return (
    <div className="space-y-6">
      <div>
        <Link href="/products" className={linkClass}>
          ← {t('products.title')}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{product.name}</h1>
        <p className="font-mono text-sm text-muted">{t('products.detail.skuLine', { sku: product.sku })}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Figure label={t('products.columns.stock')} value={format.number(product.stock)} />
        <Figure label={t('products.columns.reserved')} value={format.number(product.reserved)} />
        <Figure
          label={t('products.columns.available')}
          value={format.number(product.available)}
          negative={product.available < 0}
          note={t('products.detail.shortage')}
        />
      </div>

      <Section title={t('products.detail.dataTitle')} description={t('products.detail.dataDescription')}>
        <div className="px-5 py-4">
          <NameForm productId={product.id} name={product.name} />
        </div>
      </Section>

      <Section title={t('products.detail.stockTitle')} description={t('products.detail.stockDescription')}>
        <div className="px-5 py-4">
          <StockForm productId={product.id} stock={product.stock} />
        </div>
      </Section>

      <Section title={t('products.detail.offersTitle')} description={t('products.detail.offersDescription')}>
        {product.offers.length === 0 ? (
          <EmptyState>{t('products.detail.offersEmpty')}</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th scope="col" className={thClass}>{t('products.detail.offerColumns.connection')}</th>
                  <th scope="col" className={thClass}>{t('products.detail.offerColumns.offer')}</th>
                  <th scope="col" className={thClass}>{t('products.detail.offerColumns.link')}</th>
                  <th scope="col" className={thClass}>{t('products.detail.offerColumns.lastPushed')}</th>
                  <th scope="col" className={thClass}>
                    <span className="sr-only">{t('products.detail.offerColumns.actions')}</span>
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
                    <td className={tdClass}>{offer.linkedBy === 'manual' ? t('products.detail.linkedManually') : t('products.detail.linkedBySku')}</td>
                    <td className={tdClass}>
                      {offer.lastPushedAt ? (
                        <>
                          {t('common.units', { count: offer.lastPushedAvailable ?? 0 })}
                          <span className="block text-xs text-muted">{format.dateTime(offer.lastPushedAt)}</span>
                        </>
                      ) : (
                        <span className="text-muted">{t('products.detail.notPushed')}</span>
                      )}
                    </td>
                    <td className={`${tdClass} text-right`}>
                      <ActionForm action={unlinkOfferAction} confirm={t('products.detail.unlinkConfirm')}>
                        <input type="hidden" name="offerId" value={offer.id} />
                        <ActionButton variant="secondary" pendingLabel={t('products.detail.unlinking')}>
                          {t('products.detail.unlink')}
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

      <Section title={t('products.detail.reservationsTitle')} description={t('products.detail.reservationsDescription')}>
        {product.openReservations.length === 0 ? (
          <EmptyState>{t('products.detail.reservationsEmpty')}</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {product.openReservations.map((reservation, index) => (
              <li key={`${reservation.orderId}-${index}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                <Link href={`/orders/${reservation.orderId}`} className={linkClass}>
                  {t('products.detail.reservationOrder', { id: reservation.orderExternalId })}
                </Link>
                <span>
                  {t('common.units', { count: reservation.units })} <span className="text-muted">· {format.dateTime(reservation.createdAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}
