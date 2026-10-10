'use client'

import type { ChannelReportedPhase } from '@hanza/core'
import { ActionForm } from '@/components/action-form'
import { ActionButton, Select } from '@/components/form'
import { useT } from '@/i18n/use-t'
import { setStatusMappingAction } from '../actions'

export interface MappingRow {
  phase: ChannelReportedPhase
  /** What the Channel reports, in the request's language (labels are server-only messages). */
  label: string
  /** Label of the phase default, for the "default" choice. */
  defaultLabel: string
  /** Mapped status id, or '' for the default. */
  current: string
  /** The phase's active statuses (the current one even if inactive, so the form shows what is stored). */
  options: Array<{ id: string; label: string }>
}

export function StatusMappingForm({ connectionId, rows, disabled }: { connectionId: string; rows: MappingRow[]; disabled: boolean }) {
  const t = useT()
  return (
    <ActionForm
      action={setStatusMappingAction}
      success={t('common.saved')}
      className="grid gap-4"
      actions={disabled ? undefined : <ActionButton variant="secondary">{t('connections.detail.statusMapping.save')}</ActionButton>}
    >
      {(state) => (
        <>
          <input type="hidden" name="connectionId" value={connectionId} />
          {/* One under another: a status name is as long as the organization made it, and three columns would cut it. */}
          <div className="grid max-w-md gap-4">
            {rows.map((row) => (
              <Select
                key={row.phase}
                name={row.phase}
                label={row.label}
                defaultValue={state.values?.[row.phase] ?? row.current}
                disabled={disabled}
                error={state.fieldErrors?.[row.phase]}
              >
                <option value="">{t('connections.detail.statusMapping.defaultOption', { status: row.defaultLabel })}</option>
                {row.options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </Select>
            ))}
          </div>
        </>
      )}
    </ActionForm>
  )
}
