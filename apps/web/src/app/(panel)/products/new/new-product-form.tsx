'use client'

import Link from 'next/link'
import { ActionForm } from '@/components/action-form'
import { buttonClass } from '@/components/button-class'
import { ActionButton, Field } from '@/components/form'
import { useT } from '@/i18n/use-t'
import { createProductAction } from './actions'

export function NewProductForm() {
  const t = useT()
  return (
    <ActionForm
      action={createProductAction}
      className="grid gap-4"
      actions={
        <>
          <ActionButton pendingLabel={t('products.new.submitting')}>{t('products.new.submit')}</ActionButton>
          <Link href="/products" className={buttonClass('secondary')}>
            {t('common.cancel')}
          </Link>
        </>
      }
    >
      {(state) => (
        <>
          <Field
            name="sku"
            label={t('products.new.sku')}
            required
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
            defaultValue={state.values?.sku ?? ''}
            error={state.fieldErrors?.sku}
            hint={t('products.new.skuHint')}
            className="font-mono"
          />
          <Field
            name="name"
            label={t('products.new.name')}
            required
            maxLength={200}
            autoComplete="off"
            defaultValue={state.values?.name ?? ''}
            error={state.fieldErrors?.name}
          />
          {/* Stock is a different fact from what the Product is, so it sits apart from the two fields above. */}
          <div className="border-t border-border pt-4">
            <Field
              name="stock"
              label={t('products.new.initialStock')}
              type="number"
              inputMode="numeric"
              min={0}
              max={1_000_000}
              step={1}
              required
              defaultValue={state.values?.stock ?? '0'}
              error={state.fieldErrors?.stock}
              hint={t('products.new.initialStockHint')}
              className="w-32 tabular-nums"
            />
          </div>
        </>
      )}
    </ActionForm>
  )
}
