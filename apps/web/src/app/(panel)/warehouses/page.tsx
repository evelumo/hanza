import { listWarehouses } from '@hanza/core'
import type { Metadata } from 'next'
import { DataTable, DataTableBody, DataTableCell, DataTableHead, DataTableHeader, DataTableLinkRow, DataTableMeta, DataTableMetaItem } from '@/components/data-table'
import { NoValue } from '@/components/no-value'
import { PageHeader } from '@/components/page-header'
import { Page } from '@/components/page-layout'
import { Section, SectionContent } from '@/components/section'
import { TagBadge } from '@/components/status-badge'
import { TextLink } from '@/components/text-link'
import { getT } from '@/i18n/server'
import { getContext } from '@/lib/context'
import { getFormatters } from '@/lib/formatters'
import { requireTenant } from '@/lib/session'
import { NewWarehouseForm } from './new-warehouse-form'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('warehouses.title') }
}

export default async function WarehousesPage() {
  const { organizationId } = await requireTenant()
  const [t, format] = await Promise.all([getT(), getFormatters()])
  const warehouses = await listWarehouses(getContext(), organizationId)

  return (
    <Page>
      <PageHeader title={t('warehouses.title')} description={t('warehouses.description')} />

      <Section title={t('warehouses.listTitle')}>
        <DataTable>
          <DataTableHeader>
            <DataTableHead>{t('warehouses.columns.name')}</DataTableHead>
            <DataTableHead numeric hide="medium">
              {t('warehouses.columns.priority')}
            </DataTableHead>
            <DataTableHead numeric>{t('warehouses.columns.stock')}</DataTableHead>
            <DataTableHead numeric hide="narrow">
              {t('warehouses.columns.reserved')}
            </DataTableHead>
            <DataTableHead hide="medium">{t('warehouses.columns.channels')}</DataTableHead>
          </DataTableHeader>
          <DataTableBody>
            {warehouses.map((warehouse) => (
              <DataTableLinkRow key={warehouse.id} href={`/warehouses/${warehouse.id}`}>
                <DataTableCell narrow="primary">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <TextLink href={`/warehouses/${warehouse.id}`}>{warehouse.name}</TextLink>
                    {warehouse.isDefault ? <TagBadge label={t('warehouses.default')} /> : null}
                    {warehouse.active ? null : <TagBadge label={t('warehouses.inactive')} />}
                  </span>
                  <DataTableMeta>
                    <DataTableMetaItem label={t('warehouses.columns.reserved')}>{format.number(warehouse.reserved)}</DataTableMetaItem>
                  </DataTableMeta>
                  <DataTableMeta below="medium">
                    <DataTableMetaItem label={t('warehouses.columns.priority')}>{format.number(warehouse.priority)}</DataTableMetaItem>
                    <DataTableMetaItem label={t('warehouses.columns.channels')}>
                      {warehouse.channels.length === 0 ? <NoValue /> : warehouse.channels.map((channel) => channel.name).join(', ')}
                    </DataTableMetaItem>
                  </DataTableMeta>
                </DataTableCell>
                <DataTableCell numeric hide="medium">
                  {format.number(warehouse.priority)}
                </DataTableCell>
                <DataTableCell numeric narrow="end" narrowLabel={t('warehouses.columns.stock')}>
                  {format.number(warehouse.stock)}
                </DataTableCell>
                <DataTableCell numeric hide="narrow">
                  {format.number(warehouse.reserved)}
                </DataTableCell>
                <DataTableCell hide="medium">
                  {warehouse.channels.length === 0 ? (
                    <NoValue />
                  ) : (
                    warehouse.channels.map((channel, index) => (
                      <span key={channel.id}>
                        {index > 0 ? ', ' : null}
                        <TextLink href={`/connections/${channel.id}`}>{channel.name}</TextLink>
                      </span>
                    ))
                  )}
                </DataTableCell>
              </DataTableLinkRow>
            ))}
          </DataTableBody>
        </DataTable>
      </Section>

      <Section title={t('warehouses.newTitle')} description={t('warehouses.newDescription')}>
        <SectionContent>
          <NewWarehouseForm />
        </SectionContent>
      </Section>
    </Page>
  )
}
