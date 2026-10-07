import { getOffer } from '@hanza/core'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { useId, type ReactNode } from 'react'
import { ActionForm } from '@/components/action-form'
import { ActionButton } from '@/components/form'
import { PriceForm } from '@/components/price-form'
import { EmptyState, Section, linkClass } from '@/components/section'
import { getT } from '@/i18n/server'
import { getContext } from '@/lib/context'
import { getFormatters } from '@/lib/formatters'
import { publicationLabel, stockStatusText } from '@/lib/offer-push-status'
import { isPriceBlocked, priceStatusText } from '@/lib/price-status'
import { safeHttpUrl } from '@/lib/safe-url'
import { requireTenant } from '@/lib/session'
import { retryOfferPushAction, setOfferPriceAction } from './actions'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('offerDetail.title') }
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  const labelId = useId()
  // A named group ties the value to its label for assistive technology (and tests).
  return (
    <div role="group" aria-labelledby={labelId} className="rounded-lg border border-line bg-white px-5 py-4">
      <p id={labelId} className="text-sm text-muted">{label}</p>
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
  const retry = (push: 'stock' | 'price', label: string): ReactNode => (
    <ActionForm action={retryOfferPushAction} className="space-y-2">
      <input type="hidden" name="offerId" value={offer.id} />
      <input type="hidden" name="push" value={push} />
      <ActionButton variant="secondary" pendingLabel={t('offerPush.retrying')} aria-label={label}>
        {t('offerPush.retry')}
      </ActionButton>
    </ActionForm>
  )

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

      <Section title={t('offerDetail.stockTitle')} description={t('offerDetail.stockDescription')}>
        <div className="space-y-3 px-5 py-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Figure label={t('offerDetail.publication')} value={publicationLabel(t, offer.publication)} note={t('offerDetail.publicationHint')} />
            <Figure
              label={t('offerDetail.lastPushedStock')}
              value={offer.lastPushedAt ? t('common.units', { count: offer.lastPushedAvailable ?? 0 }) : t('offerDetail.notSent')}
              note={offer.lastPushedAt ? format.dateTime(offer.lastPushedAt) : undefined}
            />
          </div>
          <p className={`text-sm ${offer.stockStatus === 'rejected' ? 'font-medium text-amber-800' : 'text-muted'}`}>
            {stockStatusText(t, offer, format.dateTime)}
          </p>
          {offer.stockStatus === 'rejected' ? retry('stock', t('offerPush.retryStock')) : null}
        </div>
      </Section>

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
      {offer.priceStatus === 'rejected' ? (
        <div className="space-y-2">
          <p className="text-sm text-muted">{t('offerDetail.priceRetryDescription')}</p>
          {retry('price', t('offerPush.retryPrice'))}
        </div>
      ) : null}

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
              suggestion={offer.channelPrice ? { price: offer.channelPrice, label: format.money(offer.channelPrice) } : null}
            />
          </div>
        ) : (
          <EmptyState>{t('offerDetail.notLinked')}</EmptyState>
        )}
      </Section>
    </div>
  )
}
