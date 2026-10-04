'use client'

import { ActionForm } from '@/components/action-form'
import { ActionButton, Field } from '@/components/form'
import { createProductAction } from './actions'

export function NewProductForm() {
  return (
    <ActionForm action={createProductAction} className="space-y-4">
      {(state) => (
        <>
          <Field name="sku" label="SKU" required maxLength={64} defaultValue={state.values?.sku ?? ''} error={state.fieldErrors?.sku} hint="Unikalny w firmie; później nie można go zmienić." />
          <Field name="name" label="Nazwa" required maxLength={200} defaultValue={state.values?.name ?? ''} error={state.fieldErrors?.name} />
          <Field
            name="stock"
            label="Stan początkowy"
            type="number"
            inputMode="numeric"
            min={0}
            max={1_000_000}
            step={1}
            required
            defaultValue={state.values?.stock ?? '0'}
            error={state.fieldErrors?.stock}
          />
          <ActionButton pendingLabel="Dodawanie…">Dodaj produkt</ActionButton>
        </>
      )}
    </ActionForm>
  )
}
