import { listFamilies } from '@hanza/core'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { buttonClass } from '@/components/button-class'
import { Pagination } from '@/components/pagination'
import { EmptyState, linkClass, rowClass, tableClass, tdClass, thClass } from '@/components/section'
import { getT } from '@/i18n/server'
import { getContext } from '@/lib/context'
import { getFormatters } from '@/lib/formatters'
import { outOfRangeRedirect, pageWindow, parsePage } from '@/lib/pagination'
import { requireTenant } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('families.title') }
}

export default async function FamiliesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { organizationId } = await requireTenant()
  const [t, format] = await Promise.all([getT(), getFormatters()])
  const page = parsePage((await searchParams).page)
  const { total, items } = await listFamilies(getContext(), organizationId, pageWindow(page))
  const outOfRange = outOfRangeRedirect(page, total, '/families')
  if (outOfRange) redirect(outOfRange)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('families.title')}</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">{t('families.intro')}</p>
        </div>
        <Link href="/families/new" className={buttonClass('primary')}>
          {t('families.add')}
        </Link>
      </div>

      <div className="rounded-lg border border-line bg-white">
        {total === 0 ? (
          <EmptyState>{t('families.empty')}</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th scope="col" className={thClass}>{t('families.columns.name')}</th>
                  <th scope="col" className={thClass}>{t('families.columns.attributes')}</th>
                  <th scope="col" className={`${thClass} text-right`}>{t('families.columns.products')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((family) => (
                  <tr key={family.id} className={rowClass}>
                    <td className={tdClass}>
                      <Link href={`/families/${family.id}`} className={linkClass}>
                        {family.name}
                      </Link>
                    </td>
                    <td className={tdClass}>{family.attributes.join(', ')}</td>
                    <td className={`${tdClass} text-right tabular-nums`}>{format.number(family.productCount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Pagination page={page} total={total} basePath="/families" params={{}} />
    </div>
  )
}
