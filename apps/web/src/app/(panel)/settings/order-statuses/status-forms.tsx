'use client'

import type { OrderPhase } from '@hanza/core'
import type { OrderStatusColor } from '@hanza/db'
import { ActionForm } from '@/components/action-form'
import { ActionButton, Field, Select } from '@/components/form'
import { useT } from '@/i18n/use-t'
import { createOrderStatusAction, deleteOrderStatusAction, updateOrderStatusAction } from './actions'

// From the server page: importing them from `@hanza/core` would bundle the core into the browser, and labels are
// server-only messages.
export interface StatusFormOptions {
  colors: Array<{ value: OrderStatusColor; label: string }>
  nameMax: number
}

function ColorOptions({ colors }: { colors: StatusFormOptions['colors'] }) {
  const t = useT()
  return (
    <>
      <option value="">{t('settings.orderStatuses.colorNone')}</option>
      {colors.map((color) => (
        <option key={color.value} value={color.value}>
          {color.label}
        </option>
      ))}
    </>
  )
}

/** Rename and recolour; an empty name gives the status the phase's name again. */
export function StatusEditForm({
  status,
  label,
  phaseName,
  options,
}: {
  status: { id: string; name: string | null; color: OrderStatusColor | null }
  label: string
  /** Shown while the name is empty: what the status is called then. */
  phaseName: string
  options: StatusFormOptions
}) {
  const t = useT()
  return (
    <ActionForm action={updateOrderStatusAction} className="flex flex-wrap items-end gap-3">
      {(state) => (
        <>
          <input type="hidden" name="statusId" value={status.id} />
          <div className="w-56">
            <Field
              name="name"
              label={t('settings.orderStatuses.name')}
              aria-label={t('settings.orderStatuses.nameFor', { status: label })}
              maxLength={options.nameMax}
              placeholder={phaseName}
              defaultValue={state.values?.name ?? status.name ?? ''}
              error={state.fieldErrors?.name}
            />
          </div>
          <div className="w-44">
            <Select
              name="color"
              label={t('settings.orderStatuses.color')}
              aria-label={t('settings.orderStatuses.colorFor', { status: label })}
              defaultValue={state.values?.color ?? status.color ?? ''}
              error={state.fieldErrors?.color}
            >
              <ColorOptions colors={options.colors} />
            </Select>
          </div>
          <ActionButton variant="secondary">{t('settings.orderStatuses.save')}</ActionButton>
        </>
      )}
    </ActionForm>
  )
}

export function AddStatusForm({ phase, options }: { phase: OrderPhase; options: StatusFormOptions }) {
  const t = useT()
  return (
    <ActionForm action={createOrderStatusAction} className="flex flex-wrap items-end gap-3">
      {(state) => (
        <>
          <input type="hidden" name="phase" value={phase} />
          <div className="w-64">
            <Field
              name="name"
              label={t('settings.orderStatuses.name')}
              required
              maxLength={options.nameMax}
              placeholder={t('settings.orderStatuses.namePlaceholder')}
              // A successful add starts from an empty form; a failed one keeps what was typed.
              defaultValue={state.ok ? '' : (state.values?.name ?? '')}
              error={state.fieldErrors?.name}
            />
          </div>
          <div className="w-44">
            <Select name="color" label={t('settings.orderStatuses.color')} defaultValue={state.ok ? '' : (state.values?.color ?? '')} error={state.fieldErrors?.color}>
              <ColorOptions colors={options.colors} />
            </Select>
          </div>
          <ActionButton pendingLabel={t('settings.orderStatuses.adding')}>{t('settings.orderStatuses.add')}</ActionButton>
        </>
      )}
    </ActionForm>
  )
}

/** A status in use is deleted by moving its Orders to another active status of the phase, chosen here. */
export function DeleteStatusForm({
  statusId,
  label,
  inUse,
  replacements,
}: {
  statusId: string
  label: string
  inUse: boolean
  replacements: Array<{ id: string; label: string }>
}) {
  const t = useT()
  return (
    <ActionForm
      action={deleteOrderStatusAction}
      className="flex flex-wrap items-end gap-2"
      confirm={inUse ? t('settings.orderStatuses.confirmDeleteMoving', { status: label }) : t('settings.orderStatuses.confirmDelete', { status: label })}
      success={inUse ? t('settings.orderStatuses.deleteScheduled') : undefined}
    >
      <input type="hidden" name="statusId" value={statusId} />
      {inUse ? (
        <div className="w-56">
          <Select name="replacementId" label={t('settings.orderStatuses.replacementFor', { status: label })} required defaultValue={replacements[0]?.id}>
            {replacements.map((replacement) => (
              <option key={replacement.id} value={replacement.id}>
                {replacement.label}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
      <ActionButton variant="danger" pendingLabel={t('settings.orderStatuses.deleting')} aria-label={t('settings.orderStatuses.deleteFor', { status: label })}>
        {t('settings.orderStatuses.delete')}
      </ActionButton>
    </ActionForm>
  )
}
