import { getWarehouse, listEvents } from '@hanza/core'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ActionForm } from '@/components/action-form'
import { EmptyState } from '@/components/empty-state'
import { EventTimeline } from '@/components/event-timeline'
import { ActionButton } from '@/components/form'
import { PageHeader } from '@/components/page-header'
import { Page, PageColumns } from '@/components/page-layout'
import { Section, SectionContent } from '@/components/section'
import { TagBadge } from '@/components/status-badge'
import { getT } from '@/i18n/server'
import { getContext } from '@/lib/context'
import { getFormatters } from '@/lib/formatters'
import { requireTenant } from '@/lib/session'
import { deleteWarehouseAction, setWarehouseActiveAction } from '../actions'
import { WarehouseForm } from './warehouse-form'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('warehouses.detail.title') }
}

export default async function WarehousePage({ params }: { params: Promise<{ warehouseId: string }> }) {
  const { organizationId } = await requireTenant()
  const [t, format] = await Promise.all([getT(), getFormatters()])
  const { warehouseId } = await params
  const ctx = getContext()
  const warehouse = await getWarehouse(ctx, organizationId, warehouseId)
  if (!warehouse) notFound()
  const events = await listEvents(ctx, organizationId, { type: 'warehouse', id: warehouse.id }, 20)

  return (
    <Page>
      <PageHeader
        back={{ href: '/warehouses', label: t('warehouses.title') }}
        title={warehouse.name}
        badges={
          <>
            {warehouse.isDefault ? <TagBadge label={t('warehouses.default')} /> : null}
            {warehouse.active ? null : <TagBadge label={t('warehouses.inactive')} />}
          </>
        }
        meta={t('warehouses.detail.summary', { stock: format.number(warehouse.stock), reserved: format.number(warehouse.reserved) })}
      />

      <PageColumns
        aside={
          <Section title={t('warehouses.detail.historyTitle')}>
            {events.length === 0 ? (
              <EmptyState>{t('warehouses.detail.historyEmpty')}</EmptyState>
            ) : (
              <EventTimeline events={events} format={format} current={{ type: 'warehouse', id: warehouse.id }} />
            )}
          </Section>
        }
        after={
          // The default Warehouse can never be deleted, so it has no danger zone.
          warehouse.isDefault ? undefined : (
            <Section
              title={t('warehouses.detail.deleteTitle')}
              description={t('warehouses.detail.deleteHint')}
              className="border-critical-border"
            >
              <SectionContent>
                <ActionForm action={deleteWarehouseAction} confirm={t('warehouses.detail.deleteConfirm')} className="grid justify-items-start gap-2">
                  <input type="hidden" name="warehouseId" value={warehouse.id} />
                  <ActionButton variant="danger">{t('warehouses.detail.delete')}</ActionButton>
                </ActionForm>
              </SectionContent>
            </Section>
          )
        }
      >
        <Section title={t('warehouses.detail.dataTitle')}>
          <SectionContent>
            <WarehouseForm warehouseId={warehouse.id} name={warehouse.name} priority={warehouse.priority} />
          </SectionContent>
        </Section>

        <Section title={t('warehouses.detail.statusTitle')}>
          <SectionContent className="grid gap-3 text-sm">
            {warehouse.isDefault ? (
              <p className="text-muted-foreground">{t('warehouses.detail.defaultNote')}</p>
            ) : (
              <>
                <p>{warehouse.active ? t('warehouses.detail.statusActive') : t('warehouses.detail.statusInactive')}</p>
                {warehouse.channels.length > 0 ? (
                  <p className="text-muted-foreground">
                    {t('warehouses.detail.channelsLine', { channels: warehouse.channels.map((channel) => channel.name).join(', ') })}
                  </p>
                ) : null}
                <ActionForm action={setWarehouseActiveAction} className="grid justify-items-start gap-2">
                  <input type="hidden" name="warehouseId" value={warehouse.id} />
                  <input type="hidden" name="active" value={warehouse.active ? 'false' : 'true'} />
                  <ActionButton variant="secondary">
                    {warehouse.active ? t('warehouses.detail.deactivate') : t('warehouses.detail.activate')}
                  </ActionButton>
                </ActionForm>
                <p className="text-meta text-muted-foreground">{t('warehouses.detail.deactivateHint')}</p>
              </>
            )}
          </SectionContent>
        </Section>
      </PageColumns>
    </Page>
  )
}
