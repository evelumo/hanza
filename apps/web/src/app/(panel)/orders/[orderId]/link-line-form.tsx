'use client'

import { ActionForm } from '@/components/action-form'
import { ActionButton, Field } from '@/components/form'
import { useT } from '@/i18n/use-t'
import { linkOrderLineAction } from './actions'

export function LinkLineForm({ lineId, suggestedSku }: { lineId: string; suggestedSku: string | null }) {
  const t = useT()
  return (
    <ActionForm action={linkOrderLineAction} className="grid gap-2">
      {(state) => (
        <div className="flex flex-wrap items-start gap-2">
          <input type="hidden" name="orderLineId" value={lineId} />
          <Field
            id={`sku-${lineId}`}
            name="sku"
            label={t('orders.linkLine.skuLabel')}
            labelHidden
            compact
            required
            maxLength={64}
            placeholder={t('orders.linkLine.skuPlaceholder')}
            defaultValue={state.values?.sku ?? suggestedSku ?? ''}
            error={state.fieldErrors?.sku}
            className="w-36 font-mono"
          />
          <ActionButton variant="secondary" size="sm" pendingLabel={t('orders.linkLine.submitting')}>
            {t('orders.linkLine.submit')}
          </ActionButton>
        </div>
      )}
    </ActionForm>
  )
}
