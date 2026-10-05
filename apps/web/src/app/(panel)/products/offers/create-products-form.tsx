'use client'

import { ActionForm } from '@/components/action-form'
import { ActionButton } from '@/components/form'
import { createProductsFromOffersAction } from './actions'
import { skipReasonLabels, type CreateProductsState } from './state'

export const CREATE_PRODUCTS_FORM_ID = 'create-products-form'

/** The checkboxes live in the table and point here with their `form` attribute, so the per-row forms are not nested in this one. */
export function CreateProductsForm({ offers }: { offers: Array<{ id: string; name: string }> }) {
  const names = new Map(offers.map((offer) => [offer.id, offer.name]))
  return (
    <ActionForm<CreateProductsState> action={createProductsFromOffersAction} id={CREATE_PRODUCTS_FORM_ID} className="space-y-3">
      {(state) => (
        <>
          <ActionButton pendingLabel="Tworzenie…">Utwórz produkty z zaznaczonych</ActionButton>
          {state.ok ? (
            <div role="status" className="space-y-1 text-sm">
              <p className="text-green-800">Utworzono produkty: {state.created ?? 0}.</p>
              {state.skipped && state.skipped.length > 0 ? (
                <div>
                  <p className="font-medium">Pominięte: {state.skipped.length}</p>
                  <ul className="list-disc pl-5 text-muted">
                    {state.skipped.map((entry) => (
                      <li key={entry.offerId}>
                        {names.get(entry.offerId) ?? entry.offerId}: {skipReasonLabels[entry.reason]}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </ActionForm>
  )
}
