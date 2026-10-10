import { canManageOrganization, listOrderStatuses, ORDER_PHASES, ORDER_STATUS_COLORS, ORDER_STATUS_NAME_MAX } from '@hanza/core'
import { ArrowDown, ArrowUp, Hourglass } from 'lucide-react'
import type { Metadata } from 'next'
import { ActionForm } from '@/components/action-form'
import { ActionButton } from '@/components/form'
import { Notice } from '@/components/notice'
import { PageHeader } from '@/components/page-header'
import { Page } from '@/components/page-layout'
import { Section } from '@/components/section'
import { OrderStatusBadge, TagBadge } from '@/components/status-badge'
import { getT } from '@/i18n/server'
import { getContext } from '@/lib/context'
import { orderPhaseLabel, orderStatusName, statusColorLabel } from '@/lib/labels'
import { requireTenant } from '@/lib/session'
import { makeDefaultOrderStatusAction, moveOrderStatusAction, setOrderStatusActiveAction } from './actions'
import { SettingsNav } from '../settings-nav'
import { DEFAULT_STATUS_HINT_ID } from './hint-id'
import { AddStatusForm, DeleteStatusForm, StatusEditForm, type StatusFormOptions } from './status-forms'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('settings.orderStatuses.title') }
}

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
    <Page className="max-w-6xl">
      <SettingsNav current="/settings/order-statuses" />
      <PageHeader
        title={t('settings.orderStatuses.title')}
        description={
          <>
            {t('settings.orderStatuses.description')}
            {/* Said once for the four phases; every default status's name field points here as its description. */}
            <span id={DEFAULT_STATUS_HINT_ID} className="mt-1.5 block">
              {t('settings.orderStatuses.defaultsHint')}
            </span>
          </>
        }
      />

      {canManage ? null : <Notice tone="info">{t('settings.orderStatuses.adminsOnly')}</Notice>}

      {ORDER_PHASES.map((phase) => {
        const inPhase = statuses.filter((status) => status.phase === phase)
        return (
          <Section key={phase} title={orderPhaseLabel(t, phase)} description={t(`settings.orderStatuses.phaseHint.${phase}`)}>
            <ul className="divide-y divide-border">
              {inPhase.map((status, index) => {
                const label = orderStatusName(t, status)
                const inUse = status.orderCount + status.mappingCount > 0
                const replacedBy = status.replacedById ? inPhase.find((other) => other.id === status.replacedById) : undefined
                const replacements = inPhase
                  .filter((other) => other.id !== status.id && other.active)
                  .map((other) => ({ id: other.id, label: orderStatusName(t, other) }))
                const usage = [
                  t('settings.orderStatuses.orderCount', { count: status.orderCount }),
                  status.mappingCount > 0 ? t('settings.orderStatuses.usedByChannels', { count: status.mappingCount }) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')
                const editable = canManage && !status.replacedById
                return (
                  <li key={status.id} className="grid gap-x-4 gap-y-2.5 px-4 py-3 @5xl:grid-cols-[13rem_minmax(0,1fr)_auto]">
                    <div className="grid min-w-0 content-start gap-1">
                      <div className="flex min-h-7 flex-wrap items-center gap-1.5">
                        <OrderStatusBadge status={status} />
                        {status.isDefault ? <TagBadge label={t('settings.orderStatuses.default')} /> : null}
                        {status.active ? null : <TagBadge label={t('settings.orderStatuses.inactive')} />}
                      </div>
                      <p className="text-meta text-muted-foreground tabular-nums">{usage}</p>
                      {status.name === null ? <p className="text-meta text-muted-foreground">{t('settings.orderStatuses.phaseName')}</p> : null}
                    </div>

                    <div className="grid min-w-0 content-start gap-2">
                      {editable ? (
                        <StatusEditForm status={status} label={label} phaseName={orderPhaseLabel(t, phase)} options={options} />
                      ) : null}
                      {status.replacedById ? (
                        <p role="status" className="flex items-center gap-1.5 text-sm font-medium text-warning">
                          <Hourglass className="size-4 shrink-0" aria-hidden="true" />
                          {t('settings.orderStatuses.deletionInProgress', { status: replacedBy ? orderStatusName(t, replacedBy) : '—' })}
                        </p>
                      ) : null}
                    </div>

                    {editable ? (
                      <div className="flex flex-wrap items-end gap-1.5 @5xl:justify-end">
                        {index > 0 ? (
                          <ActionForm action={moveOrderStatusAction} className="contents">
                            <input type="hidden" name="statusId" value={status.id} />
                            <input type="hidden" name="direction" value="up" />
                            <ActionButton variant="ghost" size="sm" className="w-7 px-0" aria-label={t('settings.orderStatuses.moveUp', { status: label })}>
                              <ArrowUp aria-hidden="true" />
                            </ActionButton>
                          </ActionForm>
                        ) : null}
                        {index < inPhase.length - 1 ? (
                          <ActionForm action={moveOrderStatusAction} className="contents">
                            <input type="hidden" name="statusId" value={status.id} />
                            <input type="hidden" name="direction" value="down" />
                            <ActionButton variant="ghost" size="sm" className="w-7 px-0" aria-label={t('settings.orderStatuses.moveDown', { status: label })}>
                              <ArrowDown aria-hidden="true" />
                            </ActionButton>
                          </ActionForm>
                        ) : null}
                        {!status.isDefault && status.active ? (
                          <ActionForm action={makeDefaultOrderStatusAction} className="contents">
                            <input type="hidden" name="statusId" value={status.id} />
                            <ActionButton variant="secondary" size="sm">
                              {t('settings.orderStatuses.makeDefault')}
                            </ActionButton>
                          </ActionForm>
                        ) : null}
                        {status.isDefault ? null : (
                          <ActionForm action={setOrderStatusActiveAction} className="contents">
                            <input type="hidden" name="statusId" value={status.id} />
                            <input type="hidden" name="active" value={status.active ? '0' : '1'} />
                            <ActionButton variant="secondary" size="sm">
                              {status.active ? t('settings.orderStatuses.deactivate') : t('settings.orderStatuses.activate')}
                            </ActionButton>
                          </ActionForm>
                        )}
                        {status.isDefault || (inUse && replacements.length === 0) ? null : (
                          <DeleteStatusForm statusId={status.id} label={label} inUse={inUse} replacements={replacements} />
                        )}
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
            {canManage ? (
              <div className="border-t border-border bg-muted/40 px-4 py-3">
                <h3 className="mb-2 text-meta font-medium">{t('settings.orderStatuses.addTitle')}</h3>
                <AddStatusForm phase={phase} options={options} />
              </div>
            ) : null}
          </Section>
        )
      })}
    </Page>
  )
}
