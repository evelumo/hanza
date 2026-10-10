'use client'

import { CircleCheck, TriangleAlert } from 'lucide-react'
import { ActionForm } from '@/components/action-form'
import { ActionButton } from '@/components/form'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useT } from '@/i18n/use-t'
import { createProductsFromOffersAction } from './actions'
import { CREATE_PRODUCTS_FORM_ID } from './form-id'
import { SelectAll } from './select-all'
import type { CreateProductsState } from './state'
import { useOfferSelection } from './use-offer-selection'

/**
 * The table's toolbar: what is selected and the action on it. The checkboxes live in the table and point here
 * with their `form` attribute, so the per-row forms are not nested in this one.
 */
export function CreateProductsForm({ offers, selectableIds }: { offers: Array<{ id: string; name: string }>; selectableIds: readonly string[] }) {
  const t = useT()
  const { selected } = useOfferSelection(selectableIds)
  const names = new Map(offers.map((offer) => [offer.id, offer.name]))
  return (
    <section aria-label={t('offers.createTitle')} className="border-b border-border">
      <ActionForm<CreateProductsState> action={createProductsFromOffersAction} id={CREATE_PRODUCTS_FORM_ID} className="grid gap-3 px-4 py-3">
        {(state) => {
          const skipped = state.skipped ?? []
          return (
            <>
              <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
                <div className="min-w-0 flex-1 basis-72">
                  <p aria-live="polite" className="text-sm font-medium tabular-nums">
                    {t('offers.selected', { count: selected })}
                  </p>
                  <p className="mt-0.5 max-w-measure text-meta text-muted-foreground">{t('offers.createDescription')}</p>
                  {/* On a narrow container the table has no header row to hold it. */}
                  <label data-show="narrow" className="mt-2.5 flex items-center gap-2 text-sm">
                    <SelectAll selectableIds={selectableIds} labelled={false} />
                    {t('offers.selectAll')}
                  </label>
                </div>
                <ActionButton disabled={selected === 0} pendingLabel={t('offers.creating')}>
                  {t('offers.create')}
                </ActionButton>
              </div>
              {state.ok ? (
                <Alert tone={skipped.length > 0 ? 'warning' : 'success'} role="status">
                  {skipped.length > 0 ? <TriangleAlert aria-hidden="true" /> : <CircleCheck aria-hidden="true" />}
                  <AlertDescription>
                    <p className="font-medium">{t('offers.created', { count: state.created ?? 0 })}</p>
                    {skipped.length > 0 ? (
                      <div>
                        <p>{t('offers.skipped', { count: skipped.length })}</p>
                        <ul className="mt-1 list-disc pl-4">
                          {skipped.map((entry) => (
                            <li key={entry.offerId}>
                              {names.get(entry.offerId) ?? entry.offerId}: {t(`offers.skipReasons.${entry.reason}`)}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </AlertDescription>
                </Alert>
              ) : null}
            </>
          )
        }}
      </ActionForm>
    </section>
  )
}
