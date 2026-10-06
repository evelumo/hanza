import { listFamilyOptions, listProducts } from '@hanza/core'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { buttonClass } from '@/components/button-class'
import { Pagination } from '@/components/pagination'
import { EmptyState, linkClass, rowClass, tableClass, tdClass, thClass } from '@/components/section'
import { getT } from '@/i18n/server'
import { getContext } from '@/lib/context'
import { getFormatters } from '@/lib/formatters'
import { firstParam, outOfRangeRedirect, pageWindow, parsePage } from '@/lib/pagination'
import { requireTenant } from '@/lib/session'

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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t('products.title')}</h1>
        <div className="flex gap-2">
          <Link href="/products/offers" className={buttonClass('secondary')}>
            {t('products.unlinkedOffers')}
          </Link>
          <Link href="/products/new" className={buttonClass('primary')}>
            {t('products.add')}
          </Link>
        </div>
      </div>

      <form method="get" role="search" className="flex gap-2">
        <label className="sr-only" htmlFor="q">
          {t('products.searchLabel')}
        </label>
        <input
          id="q"
          name="q"
          type="search"
          defaultValue={search ?? ''}
          placeholder={t('products.searchPlaceholder')}
          className="w-full max-w-sm rounded-md border border-line bg-white px-3 py-1.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
        />
        <label className="sr-only" htmlFor="family">
          {t('products.familyFilter.label')}
        </label>
        <select
          id="family"
          name="family"
          defaultValue={familyParam ?? ''}
          className="rounded-md border border-line bg-white px-3 py-1.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
        >
          <option value="">{t('products.familyFilter.all')}</option>
          <option value="none">{t('products.familyFilter.none')}</option>
          {families.map((family) => (
            <option key={family.id} value={family.id}>
              {family.name}
            </option>
          ))}
        </select>
        <button type="submit" className={buttonClass('secondary')}>
          {t('products.search')}
        </button>
        {search || familyParam ? (
          <Link href="/products" className={buttonClass('secondary')}>
            {t('products.clear')}
          </Link>
        ) : null}
      </form>

      <div className="rounded-lg border border-line bg-white">
        {total === 0 ? (
          <EmptyState>
            {search || familyParam ? t('products.emptySearch') : t('products.empty')}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th scope="col" className={thClass}>{t('products.columns.sku')}</th>
                  <th scope="col" className={thClass}>{t('products.columns.name')}</th>
                  <th scope="col" className={thClass}>{t('products.columns.family')}</th>
                  <th scope="col" className={`${thClass} text-right`}>{t('products.columns.stock')}</th>
                  <th scope="col" className={`${thClass} text-right`}>{t('products.columns.reserved')}</th>
                  <th scope="col" className={`${thClass} text-right`}>{t('products.columns.available')}</th>
                  <th scope="col" className={`${thClass} text-right`}>{t('products.columns.offers')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((product) => (
                  <tr key={product.id} className={rowClass}>
                    <td className={`${tdClass} font-mono`}>
                      <Link href={`/products/${product.id}`} className={linkClass}>
                        {product.sku}
                      </Link>
                    </td>
                    <td className={tdClass}>{product.name}</td>
                    <td className={tdClass}>
                      {product.family ? (
                        <>
                          <Link href={`/families/${product.family.id}`} className={linkClass}>
                            {product.family.name}
                          </Link>
                          <span className="block text-xs text-muted">{product.family.attributes.map((attribute) => `${attribute.name}: ${attribute.value}`).join(' · ')}</span>
                        </>
                      ) : null}
                    </td>
                    <td className={`${tdClass} text-right tabular-nums`}>{format.number(product.stock)}</td>
                    <td className={`${tdClass} text-right tabular-nums`}>{format.number(product.reserved)}</td>
                    <td className={`${tdClass} text-right tabular-nums ${product.available < 0 ? 'font-semibold text-red-700' : ''}`}>
                      {format.number(product.available)}
                      {product.available < 0 ? <span className="sr-only"> {t('products.shortageHint')}</span> : null}
                    </td>
                    <td className={`${tdClass} text-right tabular-nums`}>{format.number(product.linkedOffers)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Pagination page={page} total={total} basePath="/products" params={filters} />
    </div>
  )
}
