'use client'

import type { Money } from '@hanza/connector-sdk'
import { useT } from '@/i18n/use-t'
import type { ActionState } from '@/lib/action-state'
import { ActionForm } from './action-form'
import { ActionButton, Field } from './form'

/**
 * Amount and currency of a price (a Product's base price or an Offer's own price). "Remove price" submits
 * `intent=clear`; Enter in a field submits the first button, which saves.
 */
export function PriceForm({
  action,
  idField,
  id,
  price,
  defaultCurrency,
}: {
  action: (previous: ActionState, formData: FormData) => Promise<ActionState>
  idField: 'productId' | 'offerId'
  id: string
  price: Money | null
  /** Suggested when there is no price yet, e.g. the Channel's currency. */
  defaultCurrency: string | null
}) {
  const t = useT()
  return (
    <ActionForm action={action} success={t('prices.form.saved')} className="flex flex-wrap items-end gap-3">
      {(state) => (
        <>
          <input type="hidden" name={idField} value={id} />
          <div className="w-40">
            <Field
              name="amount"
              label={t('prices.form.amount')}
              inputMode="decimal"
              autoComplete="off"
              required
              maxLength={21}
              defaultValue={state.values?.amount ?? price?.amount ?? ''}
              error={state.fieldErrors?.amount}
            />
          </div>
          <div className="w-28">
            <Field
              name="currency"
              label={t('prices.form.currency')}
              autoComplete="off"
              required
              minLength={3}
              maxLength={3}
              placeholder={t('prices.form.currencyPlaceholder')}
              defaultValue={state.values?.currency ?? price?.currency ?? defaultCurrency ?? ''}
              error={state.fieldErrors?.currency}
            />
          </div>
          <ActionButton name="intent" value="set">
            {t('prices.form.save')}
          </ActionButton>
          {price ? (
            <ActionButton name="intent" value="clear" variant="secondary" formNoValidate>
              {t('prices.form.clear')}
            </ActionButton>
          ) : null}
        </>
      )}
    </ActionForm>
  )
}
