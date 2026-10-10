import { getOffer } from '@hanza/core'
import { CircleMinus, Clock, ExternalLink } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { useId, type ReactNode } from 'react'
import { ActionForm } from '@/components/action-form'
import { buttonClass } from '@/components/button-class'
import { DescriptionItem, DescriptionList } from '@/components/description-list'
import { EmptyState } from '@/components/empty-state'
import { ActionButton } from '@/components/form'
import { Identifier } from '@/components/identifier'
import { NoValue } from '@/components/no-value'
import { Notice } from '@/components/notice'
import { PageHeader } from '@/components/page-header'
import { Page, PageColumns } from '@/components/page-layout'
import { PriceForm } from '@/components/price-form'
import { Section, SectionContent } from '@/components/section'
import { PublicationBadge } from '@/components/status-badge'
import { TextLink } from '@/components/text-link'
import { Badge } from '@/components/ui/badge'
import { getT } from '@/i18n/server'
import { getContext } from '@/lib/context'
import { getFormatters } from '@/lib/formatters'
import { publicationLabel, stockStatusText } from '@/lib/offer-push-status'
import { priceStatusText } from '@/lib/price-status'
import { safeHttpUrl } from '@/lib/safe-url'
import { requireTenant } from '@/lib/session'
import { cn } from '@/lib/utils'
import { retryOfferPushAction, setOfferPriceAction } from './actions'
import { pricePushState, stockPushState, type PushState } from './push-state'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('offerDetail.title') }
}

/** One fact about the Offer on its Channel. `muted` is for a value that is not there yet ("not sent yet", "No price"). */
function Figure({ label, note, muted = false, children }: { label: string; note?: string; muted?: boolean; children: ReactNode }) {
  const labelId = useId()
  // A named group ties the value to its label for assistive technology (and tests).
  return (
    <div role="group" aria-labelledby={labelId} className="min-w-0">
      <p id={labelId} className="text-meta text-muted-foreground">
        {label}
      </p>
      <p className={cn('mt-1 text-base tabular-nums', muted ? 'text-muted-foreground' : 'font-semibold')}>{children}</p>
      {note ? <p className="mt-0.5 text-meta text-muted-foreground tabular-nums">{note}</p> : null}
    </div>
  )
}

function PushStateBadge({ state, label }: { state: PushState; label: string }) {
  // The tone's own icon, except where the tone has none (neutral) or says less than the state does (waiting).
  const icon = state.kind === 'waiting' ? Clock : state.tone === 'neutral' ? CircleMinus : undefined
  return (
    <Badge tone={state.tone} icon={icon}>
      {label}
    </Badge>
  )
}

/** Only a state that needs a person is raised to a notice; the others are a quiet line under the figures. */
const needsPerson = (state: PushState) => state.tone === 'critical' || state.tone === 'attention'

export default async function OfferPage({ params }: { params: Promise<{ offerId: string }> }) {
  const { organizationId } = await requireTenant()
  const [t, format] = await Promise.all([getT(), getFormatters()])
  const { offerId } = await params
  const offer = await getOffer(getContext(), organizationId, offerId)
  if (!offer) notFound()

  const href = safeHttpUrl(offer.url)
  const none = t('prices.none')
  const stock = stockPushState(offer)
  const price = pricePushState(offer)
  const stockText = stockStatusText(t, offer, format.dateTime)
  const priceText = priceStatusText(t, offer, format.dateTime)
  const recordedAt = (at: Date): ReactNode => <p className="text-meta tabular-nums">{t('offerDetail.recordedAt', { date: format.dateTime(at) })}</p>
  const retry = (push: 'stock' | 'price', label: string): ReactNode => (
    <ActionForm action={retryOfferPushAction} className="grid gap-2">
      <input type="hidden" name="offerId" value={offer.id} />
      <input type="hidden" name="push" value={push} />
      <ActionButton variant="secondary" pendingLabel={t('offerPush.retrying')} aria-label={label} className="justify-self-start">
        {t('offerPush.retry')}
      </ActionButton>
    </ActionForm>
  )

  return (
    <Page>
      <PageHeader
        back={
          offer.product
            ? { href: `/products/${offer.product.id}`, label: t('offerDetail.backToProduct', { sku: offer.product.sku }) }
            : { href: '/products/offers', label: t('offers.title') }
        }
        title={offer.name}
        badges={<PublicationBadge publication={offer.publication} />}
        meta={t('offerDetail.connectionLine', { connection: offer.connectionName, externalId: offer.externalId })}
        actions={
          href ? (
            <a href={href} target="_blank" rel="noopener noreferrer" className={buttonClass('secondary')}>
              {t('offerDetail.viewOnChannel')}
              <ExternalLink aria-hidden="true" />
              <span className="sr-only">({t('offers.newTab')})</span>
            </a>
          ) : undefined
        }
      />

      <PageColumns
        aside={
          <>
            {offer.product ? (
              <Section title={t('offerDetail.productTitle')}>
                <SectionContent className="py-2">
                  <DescriptionList layout="inline">
                    <DescriptionItem term={t('offerDetail.productName')}>
                      <TextLink href={`/products/${offer.product.id}`}>{offer.product.name}</TextLink>
                    </DescriptionItem>
                    <DescriptionItem term={t('offers.columns.sku')}>
                      <Identifier wrap>{offer.product.sku}</Identifier>
                    </DescriptionItem>
                    <DescriptionItem term={t('offerDetail.basePrice')}>
                      {offer.product.basePrice ? (
                        <span className="tabular-nums">{format.money(offer.product.basePrice)}</span>
                      ) : (
                        <span className="text-muted-foreground">{none}</span>
                      )}
                    </DescriptionItem>
                    {offer.linkedBy ? (
                      <DescriptionItem term={t('offerDetail.linked')}>{t(`offerDetail.linkedBy.${offer.linkedBy}`)}</DescriptionItem>
                    ) : null}
                  </DescriptionList>
                </SectionContent>
              </Section>
            ) : null}

            <Section title={t('offerDetail.detailsTitle')}>
              <SectionContent className="py-2">
                <DescriptionList layout="inline">
                  <DescriptionItem term={t('offers.columns.connection')}>
                    <TextLink href={`/connections/${offer.connectionId}`}>{offer.connectionName}</TextLink>
                  </DescriptionItem>
                  <DescriptionItem term={t('offerDetail.externalId')}>
                    <Identifier wrap>{offer.externalId}</Identifier>
                  </DescriptionItem>
                  <DescriptionItem term={t('offers.columns.sku')}>
                    {offer.sku ? <Identifier wrap>{offer.sku}</Identifier> : <NoValue />}
                  </DescriptionItem>
                  <DescriptionItem term={t('offers.columns.seen')}>
                    <span className="tabular-nums">{format.dateTime(offer.lastSeenAt)}</span>
                  </DescriptionItem>
                </DescriptionList>
              </SectionContent>
            </Section>
          </>
        }
      >
        {offer.product ? null : (
          <Notice
            tone="attention"
            actions={
              <Link href="/products/offers" className={buttonClass('secondary')}>
                {t('offers.title')}
              </Link>
            }
          >
            {t('offerDetail.notLinked')}
          </Notice>
        )}

        <Section
          title={t('offerDetail.stockTitle')}
          description={t('offerDetail.stockDescription')}
          actions={<PushStateBadge state={stock} label={t(`offerDetail.pushState.${stock.kind}`)} />}
        >
          <SectionContent className="grid gap-4">
            {needsPerson(stock) ? (
              <Notice tone={stock.tone} actions={stock.kind === 'rejected' ? retry('stock', t('offerPush.retryStock')) : undefined}>
                <p>{stockText}</p>
                {offer.stockRejection ? recordedAt(offer.stockRejection.at) : null}
              </Notice>
            ) : null}
            <div className="grid gap-x-6 gap-y-4 @md:grid-cols-2">
              <Figure label={t('offerDetail.publication')} note={t('offerDetail.publicationHint')}>
                {publicationLabel(t, offer.publication)}
              </Figure>
              <Figure
                label={t('offerDetail.lastPushedStock')}
                note={offer.lastPushedAt ? format.dateTime(offer.lastPushedAt) : undefined}
                muted={!offer.lastPushedAt}
              >
                {offer.lastPushedAt ? t('common.units', { count: offer.lastPushedAvailable ?? 0 }) : t('offerDetail.notSent')}
              </Figure>
            </div>
            {/* A sent stock is already told by the figure above, with its date. */}
            {needsPerson(stock) || stock.kind === 'sent' ? null : <p className="text-sm text-muted-foreground">{stockText}</p>}
          </SectionContent>
        </Section>

        <Section title={t('offerDetail.priceTitle')} actions={<PushStateBadge state={price} label={t(`offerDetail.pushState.${price.kind}`)} />}>
          <SectionContent className="grid gap-4">
            {needsPerson(price) ? (
              <Notice tone={price.tone} actions={price.kind === 'rejected' ? retry('price', t('offerPush.retryPrice')) : undefined}>
                <p>
                  {priceText}
                  {offer.priceStatus === 'currency_mismatch' && offer.channelPrice ? (
                    <> {t('offerDetail.mismatchHint', { currency: offer.channelPrice.currency })}</>
                  ) : null}
                </p>
                {price.kind === 'rejected' ? <p>{t('offerDetail.priceRetryDescription')}</p> : null}
                {offer.priceRejection ? recordedAt(offer.priceRejection.at) : null}
              </Notice>
            ) : null}
            <div className="grid gap-x-6 gap-y-4 @md:grid-cols-3">
              <Figure
                label={t('offerDetail.effectivePrice')}
                note={offer.effectivePrice ? t(offer.priceOverride ? 'offerDetail.priceSource.override' : 'offerDetail.priceSource.base') : undefined}
                muted={!offer.effectivePrice}
              >
                {offer.effectivePrice ? format.money(offer.effectivePrice) : none}
              </Figure>
              <Figure label={t('offerDetail.channelPrice')} note={t('offerDetail.channelPriceHint')} muted={!offer.channelPrice}>
                {offer.channelPrice ? format.money(offer.channelPrice) : none}
              </Figure>
              <Figure
                label={t('offerDetail.lastPushedPrice')}
                note={offer.lastPricePushedAt ? format.dateTime(offer.lastPricePushedAt) : undefined}
                muted={!offer.lastPushedPrice}
              >
                {offer.lastPushedPrice ? format.money(offer.lastPushedPrice) : t('offerDetail.notSent')}
              </Figure>
            </div>
            {needsPerson(price) || price.kind === 'sent' ? null : <p className="text-sm text-muted-foreground">{priceText}</p>}
          </SectionContent>
        </Section>

        <Section title={t('offerDetail.overrideTitle')} description={t('offerDetail.overrideDescription')}>
          {offer.product ? (
            <SectionContent>
              <PriceForm
                action={setOfferPriceAction}
                idField="offerId"
                id={offer.id}
                price={offer.priceOverride}
                defaultCurrency={offer.channelPrice?.currency ?? offer.product.basePrice?.currency ?? null}
                suggestion={offer.channelPrice ? { price: offer.channelPrice, label: format.money(offer.channelPrice) } : null}
              />
            </SectionContent>
          ) : (
            <EmptyState>{t('offerDetail.overrideNotLinked')}</EmptyState>
          )}
        </Section>
      </PageColumns>
    </Page>
  )
}
