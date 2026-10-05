'use client'

import { ActionForm } from '@/components/action-form'
import { ActionButton } from '@/components/form'
import { linkOfferAction } from './actions'

export function LinkOfferForm({ offerId }: { offerId: string }) {
  return (
    <ActionForm action={linkOfferAction} className="space-y-1">
      {(state) => (
        <>
          <div className="flex gap-2">
            <input type="hidden" name="offerId" value={offerId} />
            <label className="sr-only" htmlFor={`sku-${offerId}`}>
              SKU produktu, z którym połączyć ofertę
            </label>
            <input
              id={`sku-${offerId}`}
              name="sku"
              required
              maxLength={64}
              placeholder="SKU produktu"
              defaultValue={state.values?.sku ?? ''}
              aria-invalid={state.fieldErrors?.sku ? true : undefined}
              className="w-36 rounded-md border border-line bg-white px-2 py-1.5 font-mono text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
            <ActionButton variant="secondary" pendingLabel="Łączenie…">
              Połącz z produktem
            </ActionButton>
          </div>
          {state.fieldErrors?.sku ? <p className="text-xs text-red-700">{state.fieldErrors.sku}</p> : null}
        </>
      )}
    </ActionForm>
  )
}
