'use client'

import { ActionForm } from '@/components/action-form'
import { ActionButton, Field } from '@/components/form'
import { useT } from '@/i18n/use-t'
import { updateWarehouseAction } from '../actions'

export function WarehouseForm({ warehouseId, name, priority }: { warehouseId: string; name: string; priority: number }) {
  const t = useT()
  return (
    <ActionForm action={updateWarehouseAction} success={t('warehouses.detail.saved')} className="space-y-4">
      {(state) => (
        <>
          <input type="hidden" name="warehouseId" value={warehouseId} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              name="name"
              label={t('warehouses.name')}
              required
              maxLength={100}
              defaultValue={state.values?.name ?? name}
              error={state.fieldErrors?.name}
            />
            <Field
              name="priority"
              label={t('warehouses.priority')}
              hint={t('warehouses.priorityHintEdit')}
              type="number"
              inputMode="numeric"
              min={0}
              max={1_000_000}
              step={1}
              required
              defaultValue={state.values?.priority ?? priority}
              error={state.fieldErrors?.priority}
            />
          </div>
          <ActionButton>{t('warehouses.detail.save')}</ActionButton>
        </>
      )}
    </ActionForm>
  )
}
