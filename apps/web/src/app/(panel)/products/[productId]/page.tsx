import { getProduct } from '@hanza/core'
import type { Metadata } from 'next'
import Link from 'next/link'
import { ActionForm } from '@/components/action-form'
import { ActionButton } from '@/components/form'
import { PriceForm } from '@/components/price-form'
import { EmptyState, Section, linkClass, rowClass, tableClass, tdClass, thClass } from '@/components/section'
import { TagBadge } from '@/components/status-badge'
import { getContext } from '@/lib/context'
import { getT } from '@/i18n/server'
import { getFormatters } from '@/lib/formatters'
import { publicationLabel, stockStatusText } from '@/lib/offer-push-status'
import { isPriceBlocked, priceStatusText } from '@/lib/price-status'
import { requireTenant } from '@/lib/session'
import { notFound } from 'next/navigation'
import { useId } from 'react'
import { setBasePriceAction, unlinkOfferAction } from './actions'
import { NameForm } from './name-form'
import { StockForm } from './stock-form'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('products.detail.title') }
}

function Figure({ label, value, negative, note }: { label: string; value: string; negative?: boolean; note?: string }) {
  const labelId = useId()
  // A named group ties the number to its label for assistive technology (and tests).
  return (
    <div role="group" aria-labelledby={labelId} className="rounded-lg border border-line bg-white px-5 py-4">
      <p id={labelId} className="text-sm text-muted">{label}</p>
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
  // Offered as a suggestion only when every Channel reports the same price, so no Channel's price is picked over another's.
  const channelPrices = [...new Map(product.offers.flatMap((offer) => (offer.channelPrice ? [[`${offer.channelPrice.amount} ${offer.channelPrice.currency}`, offer.channelPrice] as const] : []))).values()]
  const channelPrice = channelPrices.length === 1 ? channelPrices[0]! : null

  return (
    <div className="space-y-6">
      <div>
        <Link href="/products" className={linkClass}>
          ← {t('products.title')}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{product.name}</h1>
        <p className="font-mono text-sm text-muted">{t('products.detail.skuLine', { sku: product.sku })}</p>
        {product.family ? (
          <p className="text-sm text-muted">
            <Link href={`/families/${product.family.id}`} className={linkClass}>
              {t('products.detail.familyLine', { name: product.family.name })}
            </Link>{' '}
            · {product.family.attributes.map((attribute) => `${attribute.name}: ${attribute.value}`).join(' · ')}
          </p>
        ) : null}
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

      <Section
        title={t('products.detail.stockTitle')}
        description={t('products.detail.stockDescription')}
        actions={
          <Link href="/warehouses" className={linkClass}>
            {t('products.detail.manageWarehouses')}
          </Link>
        }
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead>
              <tr>
                <th scope="col" className={thClass}>{t('products.detail.warehouseColumns.warehouse')}</th>
                <th scope="col" className={thClass}>{t('products.detail.warehouseColumns.stock')}</th>
                <th scope="col" className={`${thClass} text-right`}>{t('products.detail.warehouseColumns.reserved')}</th>
                <th scope="col" className={`${thClass} text-right`}>{t('products.detail.warehouseColumns.available')}</th>
              </tr>
            </thead>
            <tbody>
              {product.warehouses.map((warehouse) => (
                <tr key={warehouse.id} className={rowClass}>
                  <th scope="row" className={`${tdClass} font-medium`}>
                    <span className="flex flex-wrap items-center gap-1.5">
                      {warehouse.name}
                      {warehouse.isDefault ? <TagBadge label={t('warehouses.default')} /> : null}
                    </span>
                  </th>
                  <td className={tdClass}>
                    <StockForm productId={product.id} warehouseId={warehouse.id} warehouseName={warehouse.name} stock={warehouse.stock} />
                  </td>
                  <td className={`${tdClass} text-right tabular-nums`}>{format.number(warehouse.reserved)}</td>
                  <td className={`${tdClass} text-right tabular-nums ${warehouse.available < 0 ? 'font-medium text-red-700' : ''}`}>
                    {format.number(warehouse.available)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title={t('products.detail.priceTitle')} description={t('products.detail.priceDescription')}>
        <div className="px-5 py-4">
          <PriceForm
            action={setBasePriceAction}
            idField="productId"
            id={product.id}
            price={product.basePrice}
            defaultCurrency={product.offers.find((offer) => offer.channelPrice)?.channelPrice?.currency ?? null}
            suggestion={channelPrice ? { price: channelPrice, label: format.money(channelPrice) } : null}
          />
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
                  <th scope="col" className={thClass}>{t('products.detail.offerColumns.publication')}</th>
                  <th scope="col" className={thClass}>{t('products.detail.offerColumns.lastPushed')}</th>
                  <th scope="col" className={thClass}>{t('products.detail.offerColumns.price')}</th>
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
                      <Link href={`/products/offers/${offer.id}`} className={linkClass}>
                        {offer.name}
                      </Link>
                      <span className="block font-mono text-xs text-muted">{offer.externalId}</span>
                    </td>
                    <td className={tdClass}>{offer.linkedBy === 'manual' ? t('products.detail.linkedManually') : t('products.detail.linkedBySku')}</td>
                    <td className={tdClass}>{publicationLabel(t, offer.publication)}</td>
                    <td className={tdClass}>
                      {offer.lastPushedAt ? (
                        <>
                          {t('common.units', { count: offer.lastPushedAvailable ?? 0 })}
                          <span className="block text-xs text-muted">{format.dateTime(offer.lastPushedAt)}</span>
                        </>
                      ) : (
                        <span className="text-muted">{t('products.detail.notPushed')}</span>
                      )}
                      {offer.stockStatus === 'rejected' || offer.stockStatus === 'not_sent' ? (
                        <span className="block max-w-xs text-xs font-medium text-amber-800">{stockStatusText(t, offer, format.dateTime)}</span>
                      ) : null}
                    </td>
                    <td className={tdClass}>
                      {offer.effectivePrice ? (
                        <>
                          <span className="tabular-nums">{format.money(offer.effectivePrice)}</span>
                          <span className="text-xs text-muted">
                            {' · '}
                            {offer.priceOverride ? t('products.detail.priceFromOffer') : t('products.detail.priceFromBase')}
                          </span>
                        </>
                      ) : (
                        <span className="text-muted">{t('prices.none')}</span>
                      )}
                      <span className={`block max-w-xs text-xs ${isPriceBlocked(offer.priceStatus) ? 'font-medium text-amber-800' : 'text-muted'}`}>
                        {priceStatusText(t, offer, format.dateTime)}
                      </span>
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
                  {t('common.units', { count: reservation.units })}{' '}
                  <span className="text-muted">
                    {t('products.detail.reservationWarehouse', { warehouse: reservation.warehouseName })} · {format.dateTime(reservation.createdAt)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}
