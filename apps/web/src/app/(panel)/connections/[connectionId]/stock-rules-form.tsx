'use client'

import { ActionForm } from '@/components/action-form'
import { ActionButton, Field } from '@/components/form'
import { useT } from '@/i18n/use-t'
import { updateStockRulesAction } from '../actions'

export function StockRulesForm({
  connectionId,
  safetyBuffer,
  channelLimit,
}: {
  connectionId: string
  safetyBuffer: number
  channelLimit: number | null
}) {
  const t = useT()
  return (
    <ActionForm
      action={updateStockRulesAction}
      success={t('connections.stockRules.saved')}
      className="grid gap-4"
      actions={<ActionButton variant="secondary">{t('connections.stockRules.save')}</ActionButton>}
    >
      {(state) => (
        <>
          <input type="hidden" name="connectionId" value={connectionId} />
          <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
            <Field
              name="safetyBuffer"
              label={t('connections.stockRules.safetyBuffer')}
              hint={t('connections.stockRules.safetyBufferHint')}
              type="number"
              inputMode="numeric"
              min={0}
              max={1_000_000}
              step={1}
              required
              defaultValue={state.values?.safetyBuffer ?? safetyBuffer}
              error={state.fieldErrors?.safetyBuffer}
            />
            <Field
              name="channelLimit"
              label={t('connections.stockRules.channelLimit')}
              hint={t('connections.stockRules.channelLimitHint')}
              type="number"
              inputMode="numeric"
              min={0}
              max={1_000_000}
              step={1}
              defaultValue={state.values?.channelLimit ?? channelLimit ?? ''}
              error={state.fieldErrors?.channelLimit}
            />
          </div>
        </>
      )}
    </ActionForm>
  )
}
