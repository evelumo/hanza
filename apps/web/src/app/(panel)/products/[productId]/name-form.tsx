'use client'

import { ActionForm } from '@/components/action-form'
import { ActionButton, Field } from '@/components/form'
import { updateProductAction } from './actions'

export function NameForm({ productId, name }: { productId: string; name: string }) {
  return (
    <ActionForm action={updateProductAction} success="Zapisano." className="flex flex-wrap items-end gap-3">
      {(state) => (
        <>
          <input type="hidden" name="productId" value={productId} />
          <div className="w-full max-w-md">
            <Field name="name" label="Nazwa" required maxLength={200} defaultValue={state.values?.name ?? name} error={state.fieldErrors?.name} />
          </div>
          <ActionButton>Zapisz nazwę</ActionButton>
        </>
      )}
    </ActionForm>
  )
}
