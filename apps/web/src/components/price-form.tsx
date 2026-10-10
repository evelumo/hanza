'use client'

import type { Money } from '@hanza/connector-sdk'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n/use-t'
import type { ActionState } from '@/lib/action-state'
import { ActionForm } from './action-form'
import { ActionButton, BesideFields, Field } from './form'

/**
 * Amount and currency of a price (a Product's base price or an Offer's own price). "Remove price" submits
 * `intent=clear`; Enter in a field submits the first button, which saves. A suggestion (the Channel price) only
 * fills the fields: a person still saves it, because Hanza never takes a Channel's price over by itself (ADR 0011).
 *
 * It follows the width it is given, not the window's. Narrow (an aside, a phone): the two fields share a line
 * and the buttons follow under them. From 36rem on: one row, the buttons level with the inputs and wrapping
 * inside their own column when there are too many for it.
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
    <div className="@container">
      <ActionForm
        action={action}
        success={t('prices.form.saved')}
        className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3 @xl:grid-cols-[10rem_7rem_minmax(0,1fr)]"
        // At the top of the row, so the buttons stay level with the inputs when an error appears under a field.
        actionsClassName="col-span-full @xl:col-span-1 @xl:col-start-3 @xl:row-start-1 @xl:self-start"
        actions={
          <BesideFields labelClassName="hidden @xl:block" className="min-w-0 flex-1">
            <ActionButton name="intent" value="set" variant="secondary">
              {t('prices.form.save')}
            </ActionButton>
            {price ? (
              <ActionButton name="intent" value="clear" variant="secondary" formNoValidate>
                {t('prices.form.clear')}
              </ActionButton>
            ) : null}
            {suggestion ? (
              <Button
                type="button"
                variant="outline"
                // The amount in its name can make it wider than a narrow card: it wraps instead.
                className="h-auto min-h-8 max-w-full py-1.5 text-left whitespace-normal"
                onClick={(event) => {
                  const fields = event.currentTarget.form?.elements
                  const amount = fields?.namedItem('amount')
                  const currency = fields?.namedItem('currency')
                  if (amount instanceof HTMLInputElement) amount.value = suggestion.price.amount
                  if (currency instanceof HTMLInputElement) currency.value = suggestion.price.currency
                }}
              >
                {t('prices.form.useChannelPrice', { price: suggestion.label })}
              </Button>
            ) : null}
          </BesideFields>
        }
      >
        {(state) => (
          <>
            <input type="hidden" name={idField} value={id} />
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
          </>
        )}
      </ActionForm>
    </div>
  )
}
