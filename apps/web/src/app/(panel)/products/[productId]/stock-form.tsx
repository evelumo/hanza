'use client'

import { ActionForm } from '@/components/action-form'
import { ActionButton, Field } from '@/components/form'
import { useT } from '@/i18n/use-t'
import { setStockAction } from './actions'

export function StockForm({ productId, stock }: { productId: string; stock: number }) {
  const t = useT()
  return (
    <ActionForm action={setStockAction} success={t('products.detail.stockSaved')} className="flex flex-wrap items-end gap-3">
      {(state) => (
        <>
          <input type="hidden" name="productId" value={productId} />
          <div className="w-40">
            <Field
              name="stock"
              label={t('products.columns.stock')}
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
          <ActionButton>{t('products.detail.saveStock')}</ActionButton>
        </>
      )}
    </ActionForm>
  )
}
