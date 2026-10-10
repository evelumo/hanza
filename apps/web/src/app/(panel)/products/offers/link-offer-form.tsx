'use client'

import { ActionForm } from '@/components/action-form'
import { ActionButton, Field } from '@/components/form'
import { useT } from '@/i18n/use-t'
import { linkOfferAction } from './actions'

export function LinkOfferForm({ offerId }: { offerId: string }) {
  const t = useT()
  return (
    // One column as wide as the controls: an error wraps under them instead of widening the table's column.
    <ActionForm action={linkOfferAction} className="grid grid-cols-[min-content] gap-2">
      {(state) => (
        <div className="flex items-start gap-2">
          <input type="hidden" name="offerId" value={offerId} />
          <div className="w-36 shrink-0">
            <Field
              id={`sku-${offerId}`}
              name="sku"
              label={t('offers.linkSkuLabel')}
              labelHidden
              compact
              required
              maxLength={64}
              placeholder={t('offers.skuPlaceholder')}
              defaultValue={state.values?.sku ?? ''}
              error={state.fieldErrors?.sku}
              className="font-mono"
            />
          </div>
          <ActionButton variant="secondary" size="sm" pendingLabel={t('offers.linking')}>
            {t('offers.link')}
          </ActionButton>
        </div>
      )}
    </ActionForm>
  )
}
