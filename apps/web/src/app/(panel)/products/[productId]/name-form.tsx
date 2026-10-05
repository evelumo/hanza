'use client'

import { ActionForm } from '@/components/action-form'
import { ActionButton, Field } from '@/components/form'
import { useT } from '@/i18n/use-t'
import { updateProductAction } from './actions'

export function NameForm({ productId, name }: { productId: string; name: string }) {
  const t = useT()
  return (
    <ActionForm action={updateProductAction} success={t('common.saved')} className="flex flex-wrap items-end gap-3">
      {(state) => (
        <>
          <input type="hidden" name="productId" value={productId} />
          <div className="w-full max-w-md">
            <Field name="name" label={t('products.detail.name')} required maxLength={200} defaultValue={state.values?.name ?? name} error={state.fieldErrors?.name} />
          </div>
          <ActionButton>{t('products.detail.saveName')}</ActionButton>
        </>
      )}
    </ActionForm>
  )
}
