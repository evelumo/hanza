import { canManageOrganization, listOrderStatuses, ORDER_PHASES, ORDER_STATUS_COLORS, ORDER_STATUS_NAME_MAX } from '@hanza/core'
import type { Metadata } from 'next'
import { ActionForm } from '@/components/action-form'
import { ActionButton } from '@/components/form'
import { Section } from '@/components/section'
import { OrderStatusBadge } from '@/components/status-badge'
import { getT } from '@/i18n/server'
import { getContext } from '@/lib/context'
import { orderPhaseLabel, orderStatusName, statusColorLabel } from '@/lib/labels'
import { requireTenant } from '@/lib/session'
import { makeDefaultOrderStatusAction, moveOrderStatusAction, setOrderStatusActiveAction } from './actions'
import { AddStatusForm, DeleteStatusForm, StatusEditForm, type StatusFormOptions } from './status-forms'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('settings.orderStatuses.title') }
}

const flagClass = 'inline-flex items-center rounded-full border border-line bg-canvas px-2 py-0.5 text-xs font-medium text-muted'

export default async function OrderStatusesPage() {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const ctx = getContext()
  const [statuses, canManage] = await Promise.all([listOrderStatuses(ctx, organizationId), canManageOrganization(ctx, organizationId, user.id)])
  const options: StatusFormOptions = {
    colors: ORDER_STATUS_COLORS.map((value) => ({ value, label: statusColorLabel(t, value) })),
    nameMax: ORDER_STATUS_NAME_MAX,
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted">{t('settings.title')}</p>
        <h1 className="text-2xl font-semibold tracking-tight">{t('settings.orderStatuses.title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">{t('settings.orderStatuses.description')}</p>
        {canManage ? null : <p className="mt-2 max-w-3xl text-sm font-medium">{t('settings.orderStatuses.adminsOnly')}</p>}
      </div>

      {ORDER_PHASES.map((phase) => {
        const inPhase = statuses.filter((status) => status.phase === phase)
        return (
          <Section key={phase} title={orderPhaseLabel(t, phase)} description={t(`settings.orderStatuses.phaseHint.${phase}`)}>
            <ul className="divide-y divide-line">
              {inPhase.map((status, index) => {
                const label = orderStatusName(t, status)
                const inUse = status.orderCount + status.mappingCount > 0
                const replacedBy = status.replacedById ? inPhase.find((other) => other.id === status.replacedById) : undefined
                const replacements = inPhase
                  .filter((other) => other.id !== status.id && other.active)
                  .map((other) => ({ id: other.id, label: orderStatusName(t, other) }))
                return (
                  <li key={status.id} className="space-y-3 px-5 py-4">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <OrderStatusBadge status={status} />
                      {status.isDefault ? <span className={flagClass}>{t('settings.orderStatuses.default')}</span> : null}
                      {status.active ? null : <span className={flagClass}>{t('settings.orderStatuses.inactive')}</span>}
                      {status.name === null ? <span className="text-muted">{t('settings.orderStatuses.phaseName')}</span> : null}
                      <span className="text-muted">· {t('settings.orderStatuses.orderCount', { count: status.orderCount })}</span>
                      {status.mappingCount > 0 ? (
                        <span className="text-muted">· {t('settings.orderStatuses.usedByChannels', { count: status.mappingCount })}</span>
                      ) : null}
                    </div>
                    {status.isDefault ? <p className="text-xs text-muted">{t('settings.orderStatuses.defaultHint')}</p> : null}
                    {status.replacedById ? (
                      <p role="status" className="text-sm font-medium">
                        {t('settings.orderStatuses.deletionInProgress', { status: replacedBy ? orderStatusName(t, replacedBy) : '—' })}
                      </p>
                    ) : null}
                    {canManage && !status.replacedById ? (
                      <>
                        <StatusEditForm status={status} label={label} phaseName={orderPhaseLabel(t, phase)} options={options} />
                        <div className="flex flex-wrap items-end gap-2">
                          {index > 0 ? (
                            <ActionForm action={moveOrderStatusAction}>
                              <input type="hidden" name="statusId" value={status.id} />
                              <input type="hidden" name="direction" value="up" />
                              <ActionButton variant="secondary" aria-label={t('settings.orderStatuses.moveUp', { status: label })}>
                                ↑
                              </ActionButton>
                            </ActionForm>
                          ) : null}
                          {index < inPhase.length - 1 ? (
                            <ActionForm action={moveOrderStatusAction}>
                              <input type="hidden" name="statusId" value={status.id} />
                              <input type="hidden" name="direction" value="down" />
                              <ActionButton variant="secondary" aria-label={t('settings.orderStatuses.moveDown', { status: label })}>
                                ↓
                              </ActionButton>
                            </ActionForm>
                          ) : null}
                          {!status.isDefault && status.active ? (
                            <ActionForm action={makeDefaultOrderStatusAction}>
                              <input type="hidden" name="statusId" value={status.id} />
                              <ActionButton variant="secondary">{t('settings.orderStatuses.makeDefault')}</ActionButton>
                            </ActionForm>
                          ) : null}
                          {status.isDefault ? null : (
                            <ActionForm action={setOrderStatusActiveAction}>
                              <input type="hidden" name="statusId" value={status.id} />
                              <input type="hidden" name="active" value={status.active ? '0' : '1'} />
                              <ActionButton variant="secondary">
                                {status.active ? t('settings.orderStatuses.deactivate') : t('settings.orderStatuses.activate')}
                              </ActionButton>
                            </ActionForm>
                          )}
                          {status.isDefault || (inUse && replacements.length === 0) ? null : (
                            <DeleteStatusForm statusId={status.id} label={label} inUse={inUse} replacements={replacements} />
                          )}
                        </div>
                      </>
                    ) : null}
                  </li>
                )
              })}
            </ul>
            {canManage ? (
              <div className="border-t border-line px-5 py-4">
                <h3 className="mb-2 text-sm font-medium">{t('settings.orderStatuses.addTitle')}</h3>
                <AddStatusForm phase={phase} options={options} />
              </div>
            ) : null}
          </Section>
        )
      })}
    </div>
  )
}
