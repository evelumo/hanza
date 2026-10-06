'use client'

import { ActionForm } from '@/components/action-form'
import { ActionButton } from '@/components/form'
import { useT } from '@/i18n/use-t'
import { setStockAction } from './actions'

/** Stock of the Product in one Warehouse, inline in the Warehouse table. */
export function StockForm({
  productId,
  warehouseId,
  warehouseName,
  stock,
}: {
  productId: string
  warehouseId: string
  warehouseName: string
  stock: number
}) {
  const t = useT()
  const inputId = `stock-${warehouseId}`
  return (
    <ActionForm action={setStockAction} success={t('products.detail.stockSaved')} className="space-y-1">
      {(state) => (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="productId" value={productId} />
            <input type="hidden" name="warehouseId" value={warehouseId} />
            <label className="sr-only" htmlFor={inputId}>
              {t('products.detail.stockIn', { warehouse: warehouseName })}
            </label>
            <input
              id={inputId}
              name="stock"
              type="number"
              inputMode="numeric"
              min={0}
              max={1_000_000}
              step={1}
              required
              defaultValue={state.values?.stock ?? stock}
              aria-invalid={state.fieldErrors?.stock ? true : undefined}
              className="w-28 rounded-md border border-line bg-white px-2 py-1.5 text-sm tabular-nums outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
            <ActionButton variant="secondary">{t('products.detail.saveStock')}</ActionButton>
          </div>
          {state.fieldErrors?.stock ? <p className="text-xs text-red-700">{state.fieldErrors.stock}</p> : null}
        </>
      )}
    </ActionForm>
  )
}
