'use client'

import { ActionForm } from '@/components/action-form'
import { ActionButton, Field } from '@/components/form'
import { useT } from '@/i18n/use-t'
import { setRetentionAction } from './actions'

export function RetentionForm({ days }: { days: number | null }) {
  const t = useT()
  return (
    <ActionForm action={setRetentionAction} success={t('privacy.retention.saved')} className="space-y-3">
      {(state) => (
        <div className="flex flex-wrap items-end gap-3">
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
        </div>
      )}
    </ActionForm>
  )
}
