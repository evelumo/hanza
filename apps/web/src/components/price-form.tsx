'use client'

import type { Money } from '@hanza/connector-sdk'
import { useT } from '@/i18n/use-t'
import type { ActionState } from '@/lib/action-state'
import { ActionForm } from './action-form'
import { buttonClass } from './button-class'
import { ActionButton, Field } from './form'

/**
 * Amount and currency of a price (a Product's base price or an Offer's own price). "Remove price" submits
 * `intent=clear`; Enter in a field submits the first button, which saves. A suggestion (the Channel price) only
 * fills the fields: a person still saves it, because Hanza never takes a Channel's price over by itself (ADR 0011).
 */
export function PriceForm({
  action,
  idField,
  id,
  price,
  defaultCurrency,
  suggestion,
}: {
  action: (previous: ActionState, formData: FormData) => Promise<ActionState>
  idField: 'productId' | 'offerId'
  id: string
  price: Money | null
  /** Suggested when there is no price yet, e.g. the Channel's currency. */
  defaultCurrency: string | null
  suggestion?: { price: Money; label: string } | null
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
          {suggestion ? (
            <button
              type="button"
              className={buttonClass('secondary')}
              onClick={(event) => {
                const fields = event.currentTarget.form?.elements
                const amount = fields?.namedItem('amount')
                const currency = fields?.namedItem('currency')
                if (amount instanceof HTMLInputElement) amount.value = suggestion.price.amount
                if (currency instanceof HTMLInputElement) currency.value = suggestion.price.currency
              }}
            >
              {t('prices.form.useChannelPrice', { price: suggestion.label })}
            </button>
          ) : null}
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
