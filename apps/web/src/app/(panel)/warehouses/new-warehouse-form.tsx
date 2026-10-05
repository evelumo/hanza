'use client'

import { ActionForm } from '@/components/action-form'
import { ActionButton, Field } from '@/components/form'
import { useT } from '@/i18n/use-t'
import { createWarehouseAction } from './actions'

export function NewWarehouseForm() {
  const t = useT()
  return (
    <ActionForm action={createWarehouseAction} className="space-y-4">
      {(state) => (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              name="name"
              label={t('warehouses.name')}
              required
              maxLength={100}
              defaultValue={state.values?.name ?? ''}
              error={state.fieldErrors?.name}
            />
            <Field
              name="priority"
              label={t('warehouses.priority')}
              hint={t('warehouses.priorityHint')}
              type="number"
              inputMode="numeric"
              min={0}
              max={1_000_000}
              step={1}
              defaultValue={state.values?.priority ?? ''}
              error={state.fieldErrors?.priority}
            />
          </div>
          <ActionButton>{t('warehouses.create')}</ActionButton>
        </>
      )}
    </ActionForm>
  )
}
