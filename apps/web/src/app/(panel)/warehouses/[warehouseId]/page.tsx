import { getWarehouse, listEvents } from '@hanza/core'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ActionForm } from '@/components/action-form'
import { ActionButton } from '@/components/form'
import { EmptyState, Section, linkClass } from '@/components/section'
import { TagBadge } from '@/components/status-badge'
import { getT } from '@/i18n/server'
import { getContext } from '@/lib/context'
import { describeEvent } from '@/lib/events'
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
    <div className="space-y-6">
      <div>
        <Link href="/warehouses" className={linkClass}>
          ← {t('warehouses.title')}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{warehouse.name}</h1>
          {warehouse.isDefault ? <TagBadge label={t('warehouses.default')} /> : null}
          {warehouse.active ? null : <TagBadge label={t('warehouses.inactive')} />}
        </div>
        <p className="mt-1 text-sm text-muted">
          {t('warehouses.detail.summary', { stock: format.number(warehouse.stock), reserved: format.number(warehouse.reserved) })}
        </p>
      </div>

      <Section title={t('warehouses.detail.dataTitle')}>
        <div className="px-5 py-4">
          <WarehouseForm warehouseId={warehouse.id} name={warehouse.name} priority={warehouse.priority} />
        </div>
      </Section>

      <Section title={t('warehouses.detail.statusTitle')}>
        <div className="space-y-4 px-5 py-4 text-sm">
          {warehouse.isDefault ? (
            <p className="text-muted">{t('warehouses.detail.defaultNote')}</p>
          ) : (
            <>
              <p>{warehouse.active ? t('warehouses.detail.statusActive') : t('warehouses.detail.statusInactive')}</p>
              {warehouse.channels.length > 0 ? (
                <p className="text-muted">
                  {t('warehouses.detail.channelsLine', { channels: warehouse.channels.map((channel) => channel.name).join(', ') })}
                </p>
              ) : null}
              <div className="flex flex-wrap items-start gap-3">
                <ActionForm action={setWarehouseActiveAction} className="space-y-2">
                  <input type="hidden" name="warehouseId" value={warehouse.id} />
                  <input type="hidden" name="active" value={warehouse.active ? 'false' : 'true'} />
                  <ActionButton variant="secondary">
                    {warehouse.active ? t('warehouses.detail.deactivate') : t('warehouses.detail.activate')}
                  </ActionButton>
                </ActionForm>
                <ActionForm action={deleteWarehouseAction} confirm={t('warehouses.detail.deleteConfirm')} className="space-y-2">
                  <input type="hidden" name="warehouseId" value={warehouse.id} />
                  <ActionButton variant="danger">{t('warehouses.detail.delete')}</ActionButton>
                </ActionForm>
              </div>
              <p className="text-xs text-muted">
                {t('warehouses.detail.deactivateHint')} {t('warehouses.detail.deleteHint')}
              </p>
            </>
          )}
        </div>
      </Section>

      <Section title={t('warehouses.detail.historyTitle')}>
        {events.length === 0 ? (
          <EmptyState>{t('warehouses.detail.historyEmpty')}</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {events.map((event) => {
              const { title, detail } = describeEvent(event.type, event.payload, t, format.number)
              return (
                <li key={event.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                  <span>
                    {title}
                    {detail ? <span className="text-muted"> · {detail}</span> : null}
                  </span>
                  <time dateTime={event.createdAt.toISOString()} className="text-muted">
                    {format.dateTime(event.createdAt)}
                  </time>
                </li>
              )
            })}
          </ul>
        )}
      </Section>
    </div>
  )
}
