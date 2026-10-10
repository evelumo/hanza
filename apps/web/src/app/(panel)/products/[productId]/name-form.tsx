'use client'

import { ActionForm } from '@/components/action-form'
import { ActionButton, Field } from '@/components/form'
import { useT } from '@/i18n/use-t'
import { updateProductAction } from './actions'

export function NameForm({ productId, name }: { productId: string; name: string }) {
  const t = useT()
  return (
    <ActionForm
      action={updateProductAction}
      success={t('common.saved')}
      className="grid gap-3"
      actions={<ActionButton variant="secondary">{t('products.detail.saveName')}</ActionButton>}
    >
      {(state) => (
        <>
          <input type="hidden" name="productId" value={productId} />
          <Field
            name="name"
            label={t('products.detail.name')}
            required
            maxLength={200}
            autoComplete="off"
            defaultValue={state.values?.name ?? name}
            error={state.fieldErrors?.name}
          />
        </>
      )}
    </ActionForm>
  )
}
