import { listWarehouses } from '@hanza/core'
import type { Metadata } from 'next'
import Link from 'next/link'
import { Section, linkClass, rowClass, tableClass, tdClass, thClass } from '@/components/section'
import { TagBadge } from '@/components/status-badge'
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
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('warehouses.title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">{t('warehouses.description')}</p>
      </div>

      <Section title={t('warehouses.listTitle')}>
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead>
              <tr>
                <th scope="col" className={thClass}>{t('warehouses.columns.name')}</th>
                <th scope="col" className={`${thClass} text-right`}>{t('warehouses.columns.priority')}</th>
                <th scope="col" className={`${thClass} text-right`}>{t('warehouses.columns.stock')}</th>
                <th scope="col" className={`${thClass} text-right`}>{t('warehouses.columns.reserved')}</th>
                <th scope="col" className={thClass}>{t('warehouses.columns.channels')}</th>
              </tr>
            </thead>
            <tbody>
              {warehouses.map((warehouse) => (
                <tr key={warehouse.id} className={rowClass}>
                  <td className={tdClass}>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Link href={`/warehouses/${warehouse.id}`} className={linkClass}>
                        {warehouse.name}
                      </Link>
                      {warehouse.isDefault ? <TagBadge label={t('warehouses.default')} /> : null}
                      {warehouse.active ? null : <TagBadge label={t('warehouses.inactive')} />}
                    </span>
                  </td>
                  <td className={`${tdClass} text-right tabular-nums`}>{format.number(warehouse.priority)}</td>
                  <td className={`${tdClass} text-right tabular-nums`}>{format.number(warehouse.stock)}</td>
                  <td className={`${tdClass} text-right tabular-nums`}>{format.number(warehouse.reserved)}</td>
                  <td className={tdClass}>
                    {warehouse.channels.length === 0 ? (
                      <span className="text-muted">{t('common.none')}</span>
                    ) : (
                      warehouse.channels.map((channel, index) => (
                        <span key={channel.id}>
                          {index > 0 ? ', ' : null}
                          <Link href={`/connections/${channel.id}`} className={linkClass}>
                            {channel.name}
                          </Link>
                        </span>
                      ))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title={t('warehouses.newTitle')} description={t('warehouses.newDescription')}>
        <div className="px-5 py-4">
          <NewWarehouseForm />
        </div>
      </Section>
    </div>
  )
}
