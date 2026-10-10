import { listOffers } from '@hanza/core'
import { CircleCheck, ExternalLink } from 'lucide-react'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableMeta,
  DataTableMetaItem,
  DataTableOnly,
  DataTableRow,
} from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import { Identifier } from '@/components/identifier'
import { NoValue } from '@/components/no-value'
import { PageHeader } from '@/components/page-header'
import { Page } from '@/components/page-layout'
import { Pagination } from '@/components/pagination'
import { Panel, Section } from '@/components/section'
import { AttentionBadge, PublicationBadge } from '@/components/status-badge'
import { TextLink, textLinkClass } from '@/components/text-link'
import { Checkbox } from '@/components/ui/checkbox'
import { getT } from '@/i18n/server'
import { getContext } from '@/lib/context'
import { getFormatters } from '@/lib/formatters'
import { outOfRangeRedirect, pageWindow, parsePage } from '@/lib/pagination'
import { safeHttpUrl } from '@/lib/safe-url'
import { requireTenant } from '@/lib/session'
import { CreateProductsForm } from './create-products-form'
import { CREATE_PRODUCTS_FORM_ID, STOCK_UNSET_SECTION_ID } from './form-id'
import { LinkOfferForm } from './link-offer-form'
import { SelectAll } from './select-all'

export const dynamic = 'force-dynamic'

// A checkbox has no text, so no baseline for the table to align its row on. The zero-width space in front of
// it gives its cell a line of text, and the box sits in the middle of that line.
const boxLine = 'flex h-5 items-center'
const lineStart = '\u200b'

/** How many Offers with unset Stock the page lists; each leads to its Product, where one save clears all of its Offers. */
const STOCK_UNSET_SHOWN = 100

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('offers.title') }
}

/**
 * The Offers that wait for a person: without a Product (paged, with the forms that link them or create Products), and
 * linked to a Product whose Stock is unset, which get no stock pushed until it is saved (#137).
 */
export default async function OffersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { organizationId } = await requireTenant()
  const [t, format] = await Promise.all([getT(), getFormatters()])
  const page = parsePage((await searchParams).page)
  const ctx = getContext()
  const [{ total, items }, stockUnset] = await Promise.all([
    listOffers(ctx, organizationId, { linked: false, ...pageWindow(page) }),
    listOffers(ctx, organizationId, { stockUnset: true, skip: 0, take: STOCK_UNSET_SHOWN }),
  ])
  const outOfRange = outOfRangeRedirect(page, total, '/products/offers')
  if (outOfRange) redirect(outOfRange)
  // A Product is created from an Offer's SKU, so only Offers that have one can be selected.
  const selectableIds = items.filter((offer) => offer.sku).map((offer) => offer.id)

  return (
    <Page>
      {/* A destination of its own in the sidebar, so it has no way "back" to Products. */}
      <PageHeader title={t('offers.title')} description={t('offers.description')} />

      {total === 0 && stockUnset.total === 0 ? (
        <Panel>
          <EmptyState icon={CircleCheck} title={t('offers.emptyTitle')}>
            {t('offers.empty')}
          </EmptyState>
        </Panel>
      ) : null}

      {total > 0 ? (
        <Section title={t('offers.unlinkedTitle')} description={t('offers.unlinkedDescription')}>
          {/* One query container for the toolbar and the table: on a narrow one "select all" moves from the table's
          header row, which is not shown there, into the toolbar. */}
          <div className="@container/table">
            <CreateProductsForm offers={items.map((offer) => ({ id: offer.id, name: offer.name }))} selectableIds={selectableIds} />
            <DataTable align="top">
              <DataTableHeader>
                <DataTableHead className="w-10 pr-0">
                  <SelectAll selectableIds={selectableIds} />
                </DataTableHead>
                <DataTableHead>{t('offers.columns.offer')}</DataTableHead>
                <DataTableHead hide="medium">{t('offers.columns.sku')}</DataTableHead>
                <DataTableHead hide="medium">{t('offers.columns.connection')}</DataTableHead>
                <DataTableHead hide="medium">{t('offers.columns.publication')}</DataTableHead>
                <DataTableHead hide="medium">{t('offers.columns.seen')}</DataTableHead>
                <DataTableHead>{t('offers.columns.link')}</DataTableHead>
              </DataTableHeader>
              <DataTableBody>
                {items.map((offer) => {
                  const href = safeHttpUrl(offer.url)
                  return (
                    <DataTableRow key={offer.id}>
                      <DataTableCell narrow="start" className="w-10 pr-0">
                        <span className={boxLine}>
                          {lineStart}
                          {offer.sku ? (
                            <Checkbox
                              name="offerIds"
                              value={offer.id}
                              form={CREATE_PRODUCTS_FORM_ID}
                              aria-label={t('offers.selectOffer', { name: offer.name })}
                            />
                          ) : (
                            // Not part of the form: "select all" must not tick it.
                            <Checkbox disabled aria-label={t('offers.selectOffer', { name: offer.name })} />
                          )}
                        </span>
                      </DataTableCell>
                      <DataTableCell narrow="primary" className="@4xl/table:min-w-56">
                        {href ? (
                          <a href={href} target="_blank" rel="noopener noreferrer" className={textLinkClass}>
                            {offer.name}
                            <ExternalLink className="ml-1 inline size-3.5 align-[-0.125em]" aria-hidden="true" />
                            <span className="sr-only"> ({t('offers.newTab')})</span>
                          </a>
                        ) : (
                          <span className="font-medium">{offer.name}</span>
                        )}
                        <Identifier className="block text-muted-foreground">{offer.externalId}</Identifier>
                        <DataTableMeta below="medium">
                          <DataTableMetaItem label={t('offers.columns.sku')}>{offer.sku ? <Identifier>{offer.sku}</Identifier> : <NoValue />}</DataTableMetaItem>
                          <DataTableMetaItem label={t('offers.columns.connection')} labelHidden>
                            {offer.connectionName}
                          </DataTableMetaItem>
                          <DataTableMetaItem label={t('offers.columns.seen')}>
                            <span className="whitespace-nowrap">{format.dateTime(offer.lastSeenAt)}</span>
                          </DataTableMetaItem>
                        </DataTableMeta>
                        <DataTableOnly below="medium" className="mt-1.5 flex">
                          <span className="sr-only">{t('offers.columns.publication')}: </span>
                          <PublicationBadge publication={offer.publication} />
                        </DataTableOnly>
                      </DataTableCell>
                      <DataTableCell hide="medium">{offer.sku ? <Identifier>{offer.sku}</Identifier> : <NoValue />}</DataTableCell>
                      <DataTableCell hide="medium">{offer.connectionName}</DataTableCell>
                      <DataTableCell hide="medium">
                        <PublicationBadge publication={offer.publication} />
                      </DataTableCell>
                      <DataTableCell hide="medium" tabular>
                        {format.dateTime(offer.lastSeenAt)}
                      </DataTableCell>
                      <DataTableCell className="@2xl/table:w-px">
                        <LinkOfferForm offerId={offer.id} />
                      </DataTableCell>
                    </DataTableRow>
                  )
                })}
              </DataTableBody>
            </DataTable>
          </div>
        </Section>
      ) : null}

      {total > 0 ? <Pagination page={page} total={total} basePath="/products/offers" /> : null}

      {stockUnset.total > 0 ? (
        <Section id={STOCK_UNSET_SECTION_ID} title={t('offers.stockUnset.title')} description={t('offers.stockUnset.description')}>
          <DataTable align="top">
            <DataTableHeader>
              <DataTableHead>{t('offers.stockUnset.columns.offer')}</DataTableHead>
              <DataTableHead>{t('offers.stockUnset.columns.product')}</DataTableHead>
              <DataTableHead hide="medium">{t('offers.stockUnset.columns.connection')}</DataTableHead>
              <DataTableHead>{t('offers.stockUnset.columns.stock')}</DataTableHead>
            </DataTableHeader>
            <DataTableBody>
              {stockUnset.items.map((offer) => (
                <DataTableRow key={offer.id}>
                  <DataTableCell narrow="primary" className="@4xl/table:min-w-56">
                    <TextLink href={`/products/offers/${offer.id}`}>{offer.name}</TextLink>
                    <Identifier className="block text-muted-foreground">{offer.externalId}</Identifier>
                    <DataTableMeta below="medium">
                      <DataTableMetaItem label={t('offers.stockUnset.columns.connection')} labelHidden>
                        {offer.connectionName}
                      </DataTableMetaItem>
                    </DataTableMeta>
                  </DataTableCell>
                  <DataTableCell narrowLabel={t('offers.stockUnset.columns.product')}>
                    {offer.productId ? (
                      <>
                        <TextLink href={`/products/${offer.productId}`}>{offer.productName}</TextLink>
                        <Identifier className="block text-muted-foreground">{offer.productSku}</Identifier>
                      </>
                    ) : (
                      <NoValue />
                    )}
                  </DataTableCell>
                  <DataTableCell hide="medium">{offer.connectionName}</DataTableCell>
                  <DataTableCell narrow="end">
                    <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <AttentionBadge label={t('offers.stockUnset.badge')} />
                      {offer.productId ? (
                        <TextLink
                          href={`/products/${offer.productId}#stock`}
                          aria-label={t('offers.stockUnset.setStockOf', { product: offer.productName ?? '' })}
                          className="text-meta whitespace-nowrap"
                        >
                          {t('offers.stockUnset.setStock')}
                        </TextLink>
                      ) : null}
                    </span>
                  </DataTableCell>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
          {stockUnset.total > stockUnset.items.length ? (
            <p className="border-t border-border px-4 py-2.5 text-meta text-muted-foreground">
              {t('offers.stockUnset.more', { count: stockUnset.total - stockUnset.items.length })}
            </p>
          ) : null}
        </Section>
      ) : null}
    </Page>
  )
}
