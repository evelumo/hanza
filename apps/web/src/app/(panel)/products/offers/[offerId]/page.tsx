import { getOffer } from '@hanza/core'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PriceForm } from '@/components/price-form'
import { EmptyState, Section, linkClass } from '@/components/section'
import { getT } from '@/i18n/server'
import { getContext } from '@/lib/context'
import { getFormatters } from '@/lib/formatters'
import { isPriceBlocked, priceStatusText } from '@/lib/price-status'
import { safeHttpUrl } from '@/lib/safe-url'
import { requireTenant } from '@/lib/session'
import { setOfferPriceAction } from './actions'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('offerDetail.title') }
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-lg border border-line bg-white px-5 py-4">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {note ? <p className="text-xs text-muted">{note}</p> : null}
    </div>
  )
}

export default async function OfferPage({ params }: { params: Promise<{ offerId: string }> }) {
  const { organizationId } = await requireTenant()
  const [t, format] = await Promise.all([getT(), getFormatters()])
  const { offerId } = await params
  const offer = await getOffer(getContext(), organizationId, offerId)
  if (!offer) notFound()

  const href = safeHttpUrl(offer.url)
  const none = t('prices.none')
  const blocked = isPriceBlocked(offer.priceStatus)

  return (
    <div className="space-y-6">
      <div>
        {offer.product ? (
          <Link href={`/products/${offer.product.id}`} className={linkClass}>
            ← {t('offerDetail.backToProduct', { sku: offer.product.sku })}
          </Link>
        ) : (
          <Link href="/products/offers" className={linkClass}>
            ← {t('offers.title')}
          </Link>
        )}
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer" className="hover:underline">
              {offer.name}
            </a>
          ) : (
            offer.name
          )}
        </h1>
        <p className="font-mono text-sm text-muted">{t('offerDetail.connectionLine', { connection: offer.connectionName, externalId: offer.externalId })}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Figure label={t('offerDetail.effectivePrice')} value={offer.effectivePrice ? format.money(offer.effectivePrice) : none} />
        <Figure
          label={t('offerDetail.channelPrice')}
          value={offer.channelPrice ? format.money(offer.channelPrice) : none}
          note={t('offerDetail.channelPriceHint')}
        />
        <Figure
          label={t('offerDetail.lastPushedPrice')}
          value={offer.lastPushedPrice ? format.money(offer.lastPushedPrice) : t('offerDetail.notSent')}
          note={offer.lastPricePushedAt ? format.dateTime(offer.lastPricePushedAt) : undefined}
        />
      </div>

      <p role="status" className={`text-sm ${blocked ? 'font-medium text-amber-800' : 'text-muted'}`}>
        {priceStatusText(t, offer, format.dateTime)}
        {offer.priceStatus === 'currency_mismatch' && offer.channelPrice ? (
          <> {t('offerDetail.mismatchHint', { currency: offer.channelPrice.currency })}</>
        ) : null}
      </p>

      <Section title={t('offerDetail.overrideTitle')} description={t('offerDetail.overrideDescription')}>
        {offer.product ? (
          <div className="space-y-3 px-5 py-4">
            <p className="text-sm text-muted">
              {t('offerDetail.productLine', {
                name: offer.product.name,
                sku: offer.product.sku,
                price: offer.product.basePrice ? format.money(offer.product.basePrice) : none,
              })}
            </p>
            <PriceForm
              action={setOfferPriceAction}
              idField="offerId"
              id={offer.id}
              price={offer.priceOverride}
              defaultCurrency={offer.channelPrice?.currency ?? offer.product.basePrice?.currency ?? null}
            />
          </div>
        ) : (
          <EmptyState>{t('offerDetail.notLinked')}</EmptyState>
        )}
      </Section>
    </div>
  )
}
