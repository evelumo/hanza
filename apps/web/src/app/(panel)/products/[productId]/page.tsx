import { getProduct, listEvents } from '@hanza/core'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { useId } from 'react'
import { ActionForm } from '@/components/action-form'
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableMeta,
  DataTableMetaItem,
  DataTableRow,
  DataTableRowHeader,
} from '@/components/data-table'
import { DescriptionItem, DescriptionList } from '@/components/description-list'
import { EmptyState } from '@/components/empty-state'
import { EventTimeline } from '@/components/event-timeline'
import { ActionButton } from '@/components/form'
import { Identifier } from '@/components/identifier'
import { NoValue } from '@/components/no-value'
import { Notice } from '@/components/notice'
import { PageHeader } from '@/components/page-header'
import { Page, PageColumns } from '@/components/page-layout'
import { PriceForm } from '@/components/price-form'
import { PushWarning } from '@/components/push-warning'
import { Panel, Section, SectionContent } from '@/components/section'
import { AttentionBadge, PublicationBadge, TagBadge } from '@/components/status-badge'
import { orderNumberClass, TextLink } from '@/components/text-link'
import { Badge } from '@/components/ui/badge'
import { getT } from '@/i18n/server'
import { getContext } from '@/lib/context'
import { getFormatters } from '@/lib/formatters'
import { stockStatusText } from '@/lib/offer-push-status'
import { isPriceBlocked, priceStatusText } from '@/lib/price-status'
import { requireTenant } from '@/lib/session'
import { cn } from '@/lib/utils'
import { setBasePriceAction, unlinkOfferAction } from './actions'
import { NameForm } from './name-form'
import { StockForm } from './stock-form'

export const dynamic = 'force-dynamic'

const HISTORY_LENGTH = 20

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('products.detail.title') }
}

/** One of the Product's three totals. A negative Available carries its minus sign; the colour only repeats it. */
function Figure({ label, value, attention = false }: { label: string; value: string; attention?: boolean }) {
  const labelId = useId()
  // A named group ties the number to its label for assistive technology (and tests).
  return (
    <div role="group" aria-labelledby={labelId} className="flex items-baseline justify-between gap-3 px-4 py-2.5 @md:block @md:py-3">
      <p id={labelId} className="text-meta text-muted-foreground">
        {label}
      </p>
      <p className={cn('text-lg leading-7 font-semibold tabular-nums', attention && 'text-attention')}>{value}</p>
    </div>
  )
}

export default async function ProductPage({ params }: { params: Promise<{ productId: string }> }) {
  const { organizationId } = await requireTenant()
  const [t, format] = await Promise.all([getT(), getFormatters()])
  const { productId } = await params
  const ctx = getContext()
  const product = await getProduct(ctx, organizationId, productId)
  if (!product) notFound()
  const events = await listEvents(ctx, organizationId, { type: 'product', id: product.id }, HISTORY_LENGTH)
  // Offered as a suggestion only when every Channel reports the same price, so no Channel's price is picked over another's.
  const channelPrices = [
    ...new Map(
      product.offers.flatMap((offer) =>
        offer.channelPrice ? [[`${offer.channelPrice.amount} ${offer.channelPrice.currency}`, offer.channelPrice] as const] : [],
      ),
    ).values(),
  ]
  const channelPrice = channelPrices.length === 1 ? channelPrices[0]! : null

  // One Warehouse can owe units while the others still have some: the total hides it, the Warehouse rows do not.
  const shortTotal = product.available < 0
  const shortage = shortTotal || product.warehouses.some((warehouse) => warehouse.available < 0)
  // The names this page already holds for what its history points at.
  const eventIdentifiers = {
    order: new Map(product.openReservations.map((reservation) => [reservation.orderId, reservation.orderExternalId])),
    offer: new Map(product.offers.map((offer) => [offer.id, offer.externalId])),
    warehouse: new Map(product.warehouses.map((warehouse) => [warehouse.id, warehouse.name])),
  }
  const pushRejected = product.offers.some((offer) => offer.stockStatus === 'rejected' || offer.priceStatus === 'rejected')

  return (
    <Page>
      <PageHeader
        back={{ href: '/products', label: t('products.title') }}
        title={product.name}
        badges={
          shortage || pushRejected ? (
            <>
              {shortage ? <AttentionBadge label={t('products.shortage')} /> : null}
              {pushRejected ? <Badge tone="warning">{t('products.detail.pushRejected')}</Badge> : null}
            </>
          ) : undefined
        }
        meta={
          <>
            {t('products.columns.sku')} <Identifier wrap>{product.sku}</Identifier>
          </>
        }
      />

      <PageColumns
        aside={
          <>
            <Section title={t('products.detail.dataTitle')}>
              <SectionContent className="grid gap-4">
                <NameForm productId={product.id} name={product.name} />
                <DescriptionList className="border-t border-border pt-4">
                  <DescriptionItem term={t('products.columns.sku')}>
                    <Identifier wrap>{product.sku}</Identifier>
                    <span className="mt-0.5 block text-meta text-muted-foreground">{t('products.detail.dataDescription')}</span>
                  </DescriptionItem>
                  <DescriptionItem term={t('products.columns.family')}>
                    {product.family ? (
                      <>
                        <TextLink href={`/families/${product.family.id}`}>{product.family.name}</TextLink>
                        {product.family.attributes.length > 0 ? (
                          <span className="mt-0.5 block text-meta text-muted-foreground">
                            {product.family.attributes.map((attribute) => `${attribute.name}: ${attribute.value}`).join(' · ')}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <NoValue />
                    )}
                  </DescriptionItem>
                </DescriptionList>
              </SectionContent>
            </Section>

            <Section title={t('products.detail.priceTitle')} description={t('products.detail.priceDescription')}>
              <SectionContent>
                <PriceForm
                  action={setBasePriceAction}
                  idField="productId"
                  id={product.id}
                  price={product.basePrice}
                  defaultCurrency={product.offers.find((offer) => offer.channelPrice)?.channelPrice?.currency ?? null}
                  suggestion={channelPrice ? { price: channelPrice, label: format.money(channelPrice) } : null}
                />
              </SectionContent>
            </Section>
          </>
        }
        after={
          <Section title={t('products.detail.historyTitle')}>
            {events.length === 0 ? (
              <EmptyState>{t('products.detail.historyEmpty')}</EmptyState>
            ) : (
              <EventTimeline events={events} format={format} current={{ type: 'product', id: product.id }} identifiers={eventIdentifiers} />
            )}
          </Section>
        }
      >
        {shortage ? (
          <Notice tone="attention" title={t('products.shortage')}>
            {shortTotal ? t('products.detail.shortage') : t('products.detail.shortageWarehouse')}
          </Notice>
        ) : null}

        {/* The totals over every Warehouse; the Stock section below splits them per Warehouse. */}
        <Panel className="grid divide-y divide-border @md:grid-cols-3 @md:divide-x @md:divide-y-0">
          <Figure label={t('products.columns.stock')} value={format.number(product.stock)} />
          <Figure label={t('products.columns.reserved')} value={format.number(product.reserved)} />
          <Figure label={t('products.columns.available')} value={format.number(product.available)} attention={shortTotal} />
        </Panel>

        <Section
          id="stock"
          title={t('products.detail.stockTitle')}
          description={t('products.detail.stockDescription')}
          actions={
            <TextLink href="/warehouses" className="text-meta">
              {t('products.detail.manageWarehouses')}
            </TextLink>
          }
        >
          {product.stockSet ? null : (
            // Unset Stock (#137): the figures count it as 0, but no Channel is told anything until it is saved.
            <SectionContent className="border-b border-border">
              <Notice tone="attention" title={t('products.detail.stockUnsetTitle')}>
                {t('products.detail.stockUnset')}
              </Notice>
            </SectionContent>
          )}
          <DataTable align="top">
            <DataTableHeader>
              <DataTableHead>{t('products.detail.warehouseColumns.warehouse')}</DataTableHead>
              <DataTableHead>{t('products.detail.warehouseColumns.stock')}</DataTableHead>
              <DataTableHead numeric hide="narrow">
                {t('products.detail.warehouseColumns.reserved')}
              </DataTableHead>
              <DataTableHead numeric>{t('products.detail.warehouseColumns.available')}</DataTableHead>
            </DataTableHeader>
            <DataTableBody>
              {product.warehouses.map((warehouse) => (
                <DataTableRow key={warehouse.id}>
                  <DataTableRowHeader narrow="primary">
                    <span className="flex flex-wrap items-baseline gap-1.5">
                      {warehouse.name}
                      {warehouse.isDefault ? <TagBadge label={t('warehouses.default')} /> : null}
                    </span>
                    <DataTableMeta>
                      <DataTableMetaItem label={t('products.detail.warehouseColumns.reserved')}>{format.number(warehouse.reserved)}</DataTableMetaItem>
                    </DataTableMeta>
                  </DataTableRowHeader>
                  <DataTableCell narrowLabel={t('products.detail.warehouseColumns.stock')}>
                    <StockForm
                      productId={product.id}
                      warehouseId={warehouse.id}
                      warehouseName={warehouse.name}
                      stock={product.stockSet ? warehouse.stock : null}
                    />
                  </DataTableCell>
                  <DataTableCell numeric hide="narrow">
                    {format.number(warehouse.reserved)}
                  </DataTableCell>
                  <DataTableCell numeric narrow="end" narrowLabel={t('products.detail.warehouseColumns.available')}>
                    <span className="inline-flex items-baseline gap-2">
                      {warehouse.available < 0 ? <AttentionBadge label={t('products.shortage')} /> : null}
                      <span className={cn(warehouse.available < 0 && 'font-semibold text-attention')}>{format.number(warehouse.available)}</span>
                    </span>
                  </DataTableCell>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        </Section>

        <Section title={t('products.detail.reservationsTitle')} description={t('products.detail.reservationsDescription')}>
          {product.openReservations.length === 0 ? (
            <EmptyState>{t('products.detail.reservationsEmpty')}</EmptyState>
          ) : (
            <ul className="divide-y divide-border">
              {product.openReservations.map((reservation, index) => (
                <li key={`${reservation.orderId}-${index}`} className="flex items-baseline justify-between gap-x-4 px-4 py-2.5">
                  <div className="min-w-0">
                    <TextLink href={`/orders/${reservation.orderId}`} className={cn(orderNumberClass, 'wrap-anywhere')}>
                      {t('products.detail.reservationOrder', { id: reservation.orderExternalId })}
                    </TextLink>
                    <p className="text-meta text-muted-foreground">
                      {t('products.detail.reservationWarehouse', { warehouse: reservation.warehouseName })} ·{' '}
                      <time dateTime={reservation.createdAt.toISOString()} className="whitespace-nowrap tabular-nums">
                        {format.dateTime(reservation.createdAt)}
                      </time>
                    </p>
                  </div>
                  <span className="font-medium whitespace-nowrap tabular-nums">{t('common.units', { count: reservation.units })}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={t('products.detail.offersTitle')} description={t('products.detail.offersDescription')}>
          {product.offers.length === 0 ? (
            <EmptyState>{t('products.detail.offersEmpty')}</EmptyState>
          ) : (
            <DataTable align="top">
              <DataTableHeader>
                <DataTableHead>{t('products.detail.offerColumns.offer')}</DataTableHead>
                <DataTableHead>{t('products.detail.offerColumns.lastPushed')}</DataTableHead>
                <DataTableHead>{t('products.detail.offerColumns.price')}</DataTableHead>
                <DataTableHead>{t('products.detail.offerColumns.link')}</DataTableHead>
              </DataTableHeader>
              <DataTableBody>
                {product.offers.map((offer) => (
                  <DataTableRow key={offer.id}>
                    <DataTableCell narrow="primary" className="@2xl/table:min-w-48">
                      {/* The Offer publication sits beside the name, as a state does everywhere else in the panel. */}
                      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <TextLink href={`/products/offers/${offer.id}`}>{offer.name}</TextLink>
                        <PublicationBadge publication={offer.publication} />
                      </span>
                      {/* The Offers of one Product tend to share its name: the Connection is what tells them apart. */}
                      <span className="mt-0.5 block text-meta text-muted-foreground">
                        {offer.connectionName} · <Identifier>{offer.externalId}</Identifier>
                      </span>
                    </DataTableCell>
                    <DataTableCell narrowLabel={t('products.detail.offerColumns.lastPushed')} className="@2xl/table:min-w-36">
                      {offer.lastPushedAt ? (
                        <>
                          <span className="whitespace-nowrap tabular-nums">{t('common.units', { count: offer.lastPushedAvailable ?? 0 })}</span>
                          <time
                            dateTime={offer.lastPushedAt.toISOString()}
                            className="block text-meta whitespace-nowrap text-muted-foreground tabular-nums"
                          >
                            {format.dateTime(offer.lastPushedAt)}
                          </time>
                        </>
                      ) : (
                        <span className="text-muted-foreground">{t('products.detail.notPushed')}</span>
                      )}
                      {offer.stockStatus === 'rejected' || offer.stockStatus === 'not_sent' || offer.stockStatus === 'unset' ? (
                        <PushWarning className="mt-0.5">{stockStatusText(t, offer, format.dateTime)}</PushWarning>
                      ) : null}
                    </DataTableCell>
                    <DataTableCell narrowLabel={t('products.detail.offerColumns.price')} className="@2xl/table:min-w-44">
                      {offer.effectivePrice ? (
                        <>
                          <span className="whitespace-nowrap tabular-nums">{format.money(offer.effectivePrice)}</span>
                          <span className="text-meta text-muted-foreground">
                            {' · '}
                            {offer.priceOverride ? t('products.detail.priceFromOffer') : t('products.detail.priceFromBase')}
                          </span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">{t('prices.none')}</span>
                      )}
                      {isPriceBlocked(offer.priceStatus) ? (
                        <PushWarning className="mt-0.5">{priceStatusText(t, offer, format.dateTime)}</PushWarning>
                      ) : (
                        <span className="mt-0.5 block max-w-xs text-meta text-muted-foreground">{priceStatusText(t, offer, format.dateTime)}</span>
                      )}
                    </DataTableCell>
                    {/* How the Offer was linked, next to the button that undoes it. */}
                    <DataTableCell narrowLabel={t('products.detail.offerColumns.link')}>
                      <ActionForm action={unlinkOfferAction} confirm={t('products.detail.unlinkConfirm')} className="grid gap-2">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="whitespace-nowrap">
                            {offer.linkedBy === 'manual' ? t('products.detail.linkedManually') : t('products.detail.linkedBySku')}
                          </span>
                          <input type="hidden" name="offerId" value={offer.id} />
                          <ActionButton variant="secondary" size="sm" pendingLabel={t('products.detail.unlinking')}>
                            {t('products.detail.unlink')}
                          </ActionButton>
                        </div>
                      </ActionForm>
                    </DataTableCell>
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>
          )}
        </Section>
      </PageColumns>
    </Page>
  )
}
