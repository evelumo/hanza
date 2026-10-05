'use client'

import { ActionForm } from '@/components/action-form'
import { ActionButton, Field } from '@/components/form'
import { useT } from '@/i18n/use-t'
import { createProductAction } from './actions'

export function NewProductForm() {
  const t = useT()
  return (
    <ActionForm action={createProductAction} className="space-y-4">
      {(state) => (
        <>
          <Field name="sku" label={t('products.new.sku')} required maxLength={64} defaultValue={state.values?.sku ?? ''} error={state.fieldErrors?.sku} hint={t('products.new.skuHint')} />
          <Field name="name" label={t('products.new.name')} required maxLength={200} defaultValue={state.values?.name ?? ''} error={state.fieldErrors?.name} />
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
          />
          <ActionButton pendingLabel={t('products.new.submitting')}>{t('products.new.submit')}</ActionButton>
        </>
      )}
    </ActionForm>
  )
}
