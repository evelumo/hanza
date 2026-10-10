import { listFamilyOptions, listProducts } from '@hanza/core'
import { Package, SearchX } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { buttonClass } from '@/components/button-class'
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableLinkRow,
  DataTableMeta,
  DataTableMetaItem,
} from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import { FilterBar, FilterClear, FilterForm, FilterSelect, SearchField } from '@/components/filter-bar'
import { Identifier } from '@/components/identifier'
import { NoValue } from '@/components/no-value'
import { PageHeader } from '@/components/page-header'
import { Page } from '@/components/page-layout'
import { Pagination } from '@/components/pagination'
import { Panel } from '@/components/section'
import { AttentionBadge } from '@/components/status-badge'
import { TextLink } from '@/components/text-link'
import { Button } from '@/components/ui/button'
import { getT } from '@/i18n/server'
import { getContext } from '@/lib/context'
import { getFormatters } from '@/lib/formatters'
import { firstParam, outOfRangeRedirect, pageWindow, parsePage } from '@/lib/pagination'
import { requireTenant } from '@/lib/session'
import { cn } from '@/lib/utils'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('products.title') }
}

export default async function ProductsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { organizationId } = await requireTenant()
  const [t, format] = await Promise.all([getT(), getFormatters()])
  const params = await searchParams
  const search = firstParam(params.q)?.trim().slice(0, 100) || undefined
  const familyParam = firstParam(params.family)?.trim().slice(0, 64) || undefined
  const page = parsePage(params.page)
  const ctx = getContext()
  const [{ total, items }, families] = await Promise.all([
    listProducts(ctx, organizationId, {
      search,
      family: familyParam === 'none' ? 'none' : familyParam ? { id: familyParam } : undefined,
      ...pageWindow(page),
    }),
    listFamilyOptions(ctx, organizationId),
  ])
  const filters = { q: search, family: familyParam }
  const outOfRange = outOfRangeRedirect(page, total, '/products', filters)
  if (outOfRange) redirect(outOfRange)
  const filtered = Boolean(search || familyParam)
  const noProducts = total === 0 && !filtered

  const addLink = (
    <Link href="/products/new" className={buttonClass('primary')}>
      {t('products.add')}
    </Link>
  )

  return (
    <Page>
      {/* With no Product the empty state carries the actions, so the page never has two links with the same name. */}
      <PageHeader
        title={t('products.title')}
        actions={
          noProducts ? undefined : (
            <>
              <Link href="/products/offers" className={buttonClass('secondary')}>
                {t('products.unlinkedOffers')}
              </Link>
              {addLink}
            </>
          )
        }
      />

      <Panel>
        {noProducts ? null : (
          <FilterBar>
            <FilterForm action="/products" role="search" className="min-w-0 flex-1">
              <SearchField label={t('products.searchLabel')} placeholder={t('products.searchPlaceholder')} defaultValue={search ?? ''} maxLength={100} />
              <FilterSelect name="family" label={t('products.familyFilter.label')} defaultValue={familyParam ?? ''}>
                <option value="">{t('products.familyFilter.all')}</option>
                <option value="none">{t('products.familyFilter.none')}</option>
                {families.map((family) => (
                  <option key={family.id} value={family.id}>
                    {family.name}
                  </option>
                ))}
              </FilterSelect>
              <Button type="submit" variant="outline" size="sm">
                {t('products.search')}
              </Button>
            </FilterForm>
            {filtered ? <FilterClear href="/products" /> : null}
          </FilterBar>
        )}

        {total === 0 ? (
          filtered ? (
            <EmptyState
              icon={SearchX}
              title={t('products.emptySearchTitle')}
              action={
                <Link href="/products" className={buttonClass('secondary')}>
                  {t('common.clearFilters')}
                </Link>
              }
            >
              {t('products.emptySearch')}
            </EmptyState>
          ) : (
            <EmptyState
              icon={Package}
              title={t('products.emptyTitle')}
              action={
                <>
                  <Link href="/products/offers" className={buttonClass('secondary')}>
                    {t('products.emptyFromOffers')}
                  </Link>
                  {addLink}
                </>
              }
            >
              {t('products.empty')}
            </EmptyState>
          )
        ) : (
          <DataTable>
            <DataTableHeader>
              <DataTableHead>{t('products.columns.name')}</DataTableHead>
              <DataTableHead hide="medium">{t('products.columns.sku')}</DataTableHead>
              <DataTableHead hide="medium">{t('products.columns.family')}</DataTableHead>
              <DataTableHead numeric hide="narrow">
                {t('products.columns.stock')}
              </DataTableHead>
              <DataTableHead numeric hide="narrow">
                {t('products.columns.reserved')}
              </DataTableHead>
              <DataTableHead numeric>{t('products.columns.available')}</DataTableHead>
              <DataTableHead numeric hide="medium">
                {t('products.columns.offers')}
              </DataTableHead>
            </DataTableHeader>
            <DataTableBody>
              {items.map((product) => {
                const shortage = product.available < 0
                return (
                  <DataTableLinkRow key={product.id} href={`/products/${product.id}`}>
                    <DataTableCell narrow="primary" className="@4xl/table:min-w-48">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <TextLink href={`/products/${product.id}`}>{product.name}</TextLink>
                        {shortage ? <AttentionBadge label={t('products.shortage')} /> : null}
                      </span>
                      <DataTableMeta below="medium">
                        <DataTableMetaItem label={t('products.columns.sku')} labelHidden>
                          <Identifier>{product.sku}</Identifier>
                        </DataTableMetaItem>
                        {product.family ? (
                          <DataTableMetaItem label={t('products.columns.family')} labelHidden>
                            {product.family.name}
                          </DataTableMetaItem>
                        ) : null}
                        <DataTableMetaItem label={t('products.columns.offers')}>{format.number(product.linkedOffers)}</DataTableMetaItem>
                      </DataTableMeta>
                      <DataTableMeta>
                        <DataTableMetaItem label={t('products.columns.stock')}>{format.number(product.stock)}</DataTableMetaItem>
                        <DataTableMetaItem label={t('products.columns.reserved')}>{format.number(product.reserved)}</DataTableMetaItem>
                      </DataTableMeta>
                    </DataTableCell>
                    <DataTableCell hide="medium">
                      <Identifier>{product.sku}</Identifier>
                    </DataTableCell>
                    <DataTableCell hide="medium">
                      {product.family ? (
                        <>
                          <TextLink href={`/families/${product.family.id}`}>{product.family.name}</TextLink>
                          <span className="block text-meta text-muted-foreground">
                            {product.family.attributes.map((attribute) => `${attribute.name}: ${attribute.value}`).join(' · ')}
                          </span>
                        </>
                      ) : (
                        <NoValue />
                      )}
                    </DataTableCell>
                    <DataTableCell numeric hide="narrow">
                      {format.number(product.stock)}
                    </DataTableCell>
                    <DataTableCell numeric hide="narrow">
                      {format.number(product.reserved)}
                    </DataTableCell>
                    {/* The minus sign and the badge beside the name say Shortage; the colour only repeats it. */}
                    <DataTableCell
                      numeric
                      narrow="end"
                      narrowLabel={t('products.columns.available')}
                      className={cn(shortage && 'font-semibold text-attention')}
                    >
                      {format.number(product.available)}
                    </DataTableCell>
                    <DataTableCell numeric hide="medium">
                      {format.number(product.linkedOffers)}
                    </DataTableCell>
                  </DataTableLinkRow>
                )
              })}
            </DataTableBody>
          </DataTable>
        )}
      </Panel>

      {total > 0 ? <Pagination page={page} total={total} basePath="/products" params={filters} /> : null}
    </Page>
  )
}
