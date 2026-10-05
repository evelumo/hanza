'use client'

import { ActionForm } from '@/components/action-form'
import { ActionButton } from '@/components/form'
import { useT } from '@/i18n/use-t'
import { linkOrderLineAction } from './actions'

export function LinkLineForm({ lineId, suggestedSku }: { lineId: string; suggestedSku: string | null }) {
  const t = useT()
  return (
    <ActionForm action={linkOrderLineAction} className="space-y-1">
      {(state) => (
        <>
          <div className="flex flex-wrap gap-2">
            <input type="hidden" name="orderLineId" value={lineId} />
            <label className="sr-only" htmlFor={`sku-${lineId}`}>
              {t('orders.linkLine.skuLabel')}
            </label>
            <input
              id={`sku-${lineId}`}
              name="sku"
              required
              maxLength={64}
              placeholder={t('orders.linkLine.skuPlaceholder')}
              defaultValue={state.values?.sku ?? suggestedSku ?? ''}
              aria-invalid={state.fieldErrors?.sku ? true : undefined}
              className="w-40 rounded-md border border-line bg-white px-2 py-1.5 font-mono text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
            <ActionButton variant="secondary" pendingLabel={t('orders.linkLine.submitting')}>
              {t('orders.linkLine.submit')}
            </ActionButton>
          </div>
          {state.fieldErrors?.sku ? <p className="text-xs text-red-700">{state.fieldErrors.sku}</p> : null}
        </>
      )}
    </ActionForm>
  )
}
