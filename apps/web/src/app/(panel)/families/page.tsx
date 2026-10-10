import { listFamilies } from '@hanza/core'
import { Layers } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { buttonClass } from '@/components/button-class'
import { DataTable, DataTableBody, DataTableCell, DataTableHead, DataTableHeader, DataTableLinkRow, DataTableMeta, DataTableMetaItem } from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { Page } from '@/components/page-layout'
import { Pagination } from '@/components/pagination'
import { Panel } from '@/components/section'
import { TextLink } from '@/components/text-link'
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

  const addLink = (
    <Link href="/families/new" className={buttonClass('primary')}>
      {t('families.add')}
    </Link>
  )

  return (
    <Page>
      {/* With no family the empty state carries the action, so the page never has two links with the same name. */}
      <PageHeader title={t('families.title')} description={t('families.intro')} actions={total > 0 ? addLink : undefined} />

      <Panel>
        {total === 0 ? (
          <EmptyState icon={Layers} title={t('families.emptyTitle')} action={addLink}>
            {t('families.empty')}
          </EmptyState>
        ) : (
          <DataTable>
            <DataTableHeader>
              <DataTableHead>{t('families.columns.name')}</DataTableHead>
              <DataTableHead hide="narrow">{t('families.columns.attributes')}</DataTableHead>
              <DataTableHead numeric>{t('families.columns.products')}</DataTableHead>
            </DataTableHeader>
            <DataTableBody>
              {items.map((family) => (
                <DataTableLinkRow key={family.id} href={`/families/${family.id}`}>
                  <DataTableCell narrow="primary">
                    <TextLink href={`/families/${family.id}`}>{family.name}</TextLink>
                    <DataTableMeta>
                      <DataTableMetaItem label={t('families.columns.attributes')} labelHidden>
                        {family.attributes.join(', ')}
                      </DataTableMetaItem>
                    </DataTableMeta>
                  </DataTableCell>
                  <DataTableCell hide="narrow" className="text-muted-foreground">
                    {family.attributes.join(', ')}
                  </DataTableCell>
                  <DataTableCell numeric narrow="end" narrowLabel={t('families.columns.products')}>
                    {format.number(family.productCount)}
                  </DataTableCell>
                </DataTableLinkRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
      </Panel>

      {total > 0 ? <Pagination page={page} total={total} basePath="/families" params={{}} /> : null}
    </Page>
  )
}
