'use client'

import { ActionForm } from '@/components/action-form'
import { ActionButton, Field } from '@/components/form'
import { useT } from '@/i18n/use-t'
import { setStockAction } from './actions'

/** Stock of the Product in one Warehouse, inline in the Warehouse table. `stock` is null while the Product's Stock is unset: the field starts empty. */
export function StockForm({
  productId,
  warehouseId,
  warehouseName,
  stock,
}: {
  productId: string
  warehouseId: string
  warehouseName: string
  stock: number | null
}) {
  const t = useT()
  return (
    // As wide as its column, so the note that follows a save wraps inside it and the other columns stay put;
    // in a narrow row, where it has a line of its own, as wide as that line allows.
    <ActionForm action={setStockAction} success={t('products.detail.stockSaved')} className="grid w-60 gap-2 @max-2xl/table:w-full @max-2xl/table:max-w-60">
      {(state) => (
        <div className="flex flex-wrap items-start gap-2">
          <input type="hidden" name="productId" value={productId} />
          <input type="hidden" name="warehouseId" value={warehouseId} />
          <Field
            id={`stock-${warehouseId}`}
            name="stock"
            label={t('products.detail.stockIn', { warehouse: warehouseName })}
            labelHidden
            compact
            type="number"
            inputMode="numeric"
            min={0}
            max={1_000_000}
            step={1}
            required
            defaultValue={state.values?.stock ?? stock ?? ''}
            error={state.fieldErrors?.stock}
            className="w-24 text-right tabular-nums"
          />
          <ActionButton variant="secondary" size="sm">
            {t('products.detail.saveStock')}
          </ActionButton>
        </div>
      )}
    </ActionForm>
  )
}
