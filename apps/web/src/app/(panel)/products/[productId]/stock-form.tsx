'use client'

import { ActionForm } from '@/components/action-form'
import { ActionButton, Field } from '@/components/form'
import { setStockAction } from './actions'

export function StockForm({ productId, stock }: { productId: string; stock: number }) {
  return (
    <ActionForm action={setStockAction} success="Zapisano. Nowy stan zostanie wysłany do kanałów." className="flex flex-wrap items-end gap-3">
      {(state) => (
        <>
          <input type="hidden" name="productId" value={productId} />
          <div className="w-40">
            <Field
              name="stock"
              label="Stan"
              type="number"
              inputMode="numeric"
              min={0}
              max={1_000_000}
              step={1}
              required
              defaultValue={state.values?.stock ?? stock}
              error={state.fieldErrors?.stock}
            />
          </div>
          <ActionButton>Zapisz stan</ActionButton>
        </>
      )}
    </ActionForm>
  )
}
