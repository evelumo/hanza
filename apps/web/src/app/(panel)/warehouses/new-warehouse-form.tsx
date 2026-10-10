'use client'

import { ActionForm } from '@/components/action-form'
import { ActionButton, BesideFields, Field } from '@/components/form'
import { useT } from '@/i18n/use-t'
import { createWarehouseAction } from './actions'

export function NewWarehouseForm() {
  const t = useT()
  return (
    // One row where the section is wide enough for it (48rem), the button level with the inputs; a stack otherwise.
    <div className="@container">
      <ActionForm
        action={createWarehouseAction}
        className="grid max-w-lg gap-3 @3xl:max-w-none @3xl:grid-cols-[16rem_18rem_minmax(0,1fr)]"
        // At the top of the row: a hint under a field makes the row higher than the buttons.
        actionsClassName="@3xl:col-start-3 @3xl:row-start-1 @3xl:self-start"
        actions={
          <BesideFields labelClassName="hidden @3xl:block">
            <ActionButton>{t('warehouses.create')}</ActionButton>
          </BesideFields>
        }
      >
        {(state) => (
          <>
            <Field name="name" label={t('warehouses.name')} required maxLength={100} defaultValue={state.values?.name ?? ''} error={state.fieldErrors?.name} />
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
          </>
        )}
      </ActionForm>
    </div>
  )
}
