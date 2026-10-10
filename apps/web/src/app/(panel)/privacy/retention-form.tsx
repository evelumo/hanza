'use client'

import { useActionState } from 'react'
import { ActionForm } from '@/components/action-form'
import { ActionButton, Field, FormError, FormSuccess } from '@/components/form'
import { Notice } from '@/components/notice'
import { useT } from '@/i18n/use-t'
import { setRetentionAction, type RetentionState } from './actions'
import { useResultKey } from './use-result-key'

type Confirmation = NonNullable<RetentionState['confirm']>

/**
 * Saving a new or shorter period first returns how many Orders the next check would erase; only the
 * confirmation form (a separate form, with `confirmed=1`) saves it.
 */
export function RetentionForm({ days }: { days: number | null }) {
  const t = useT()
  const [state, action] = useActionState(setRetentionAction, {} as RetentionState)
  const round = useResultKey(state)

  return (
    <div className="space-y-4">
      <form action={action} className="flex flex-col items-start gap-3">
        <div className="w-full max-w-lg">
          <Field
            name="retentionDays"
            label={t('privacy.retention.label')}
            hint={t('privacy.retention.hint')}
            type="number"
            inputMode="numeric"
            min={1}
            max={3650}
            step={1}
            defaultValue={state.values?.retentionDays ?? (days === null ? '' : String(days))}
            error={state.fieldErrors?.retentionDays}
            className="w-32 tabular-nums"
          />
        </div>
        {/* The answer sits between the field and the button, where the eye already is. */}
        <FormError message={state.error ?? null} />
        <FormSuccess message={state.ok ? t('privacy.retention.saved') : null} />
        <ActionButton variant="secondary">{t('privacy.retention.save')}</ActionButton>
      </form>

      {state.confirm ? <RetentionConfirmation key={round} confirm={state.confirm} /> : null}
    </div>
  )
}

function RetentionConfirmation({ confirm }: { confirm: Confirmation }) {
  const t = useT()
  const erases = confirm.count > 0

  return (
    <ActionForm action={setRetentionAction} confirm={erases ? t('privacy.retention.confirmDialog') : undefined} className="grid gap-3">
      {(result) =>
        result.ok ? (
          <FormSuccess message={t('privacy.retention.saved')} />
        ) : (
          <Notice
            tone={erases ? 'warning' : 'info'}
            title={t('privacy.retention.confirmTitle')}
            actions={
              <>
                <input type="hidden" name="retentionDays" value={String(confirm.days)} />
                <input type="hidden" name="confirmed" value="1" />
                {erases ? (
                  <ActionButton variant="danger">{t('privacy.retention.confirm')}</ActionButton>
                ) : (
                  <ActionButton>{t('privacy.retention.save')}</ActionButton>
                )}
              </>
            }
          >
            {t('privacy.retention.confirmCount', { count: confirm.count, days: confirm.days })}
          </Notice>
        )
      }
    </ActionForm>
  )
}
