'use client'

import { useActionState } from 'react'
import { ActionButton, Field, FormError } from '@/components/form'
import { useT } from '@/i18n/use-t'
import { setRetentionAction, type RetentionState } from './actions'

/**
 * Saving a new or shorter period first returns how many Orders the next check would erase; only the
 * confirmation form (a separate form, with `confirmed=1`) saves it.
 */
export function RetentionForm({ days }: { days: number | null }) {
  const t = useT()
  const [state, action] = useActionState(setRetentionAction, {} as RetentionState)
  const confirm = state.confirm

  return (
    <div className="space-y-3">
      <form action={action} className="flex flex-wrap items-end gap-3">
        <div className="w-64">
          <Field
            name="retentionDays"
            label={t('privacy.retention.label')}
            aria-describedby="retention-hint"
            type="number"
            inputMode="numeric"
            min={1}
            max={3650}
            step={1}
            defaultValue={state.values?.retentionDays ?? (days === null ? '' : String(days))}
            error={state.fieldErrors?.retentionDays}
          />
        </div>
        <ActionButton>{t('privacy.retention.save')}</ActionButton>
        <p id="retention-hint" className="basis-full text-xs text-muted">
          {t('privacy.retention.hint')}
        </p>
        <div className="basis-full">
          <FormError message={state.error ?? null} />
          {state.ok ? (
            <p role="status" className="text-sm text-green-800">
              {t('privacy.retention.saved')}
            </p>
          ) : null}
        </div>
      </form>

      {confirm ? (
        <form
          action={action}
          role="status"
          aria-label={t('privacy.retention.confirmTitle')}
          className="space-y-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm"
          onSubmit={(event) => {
            if (confirm.count > 0 && !window.confirm(t('privacy.retention.confirmDialog'))) event.preventDefault()
          }}
        >
          <p className="font-medium text-red-900">{t('privacy.retention.confirmTitle')}</p>
          <p>{t('privacy.retention.confirmCount', { count: confirm.count, days: confirm.days })}</p>
          <input type="hidden" name="retentionDays" value={String(confirm.days)} />
          <input type="hidden" name="confirmed" value="1" />
          <ActionButton variant="danger">{t('privacy.retention.confirm')}</ActionButton>
        </form>
      ) : null}
    </div>
  )
}
