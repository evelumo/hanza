'use client'

import { ActionForm } from '@/components/action-form'
import { ConnectorFields } from '@/components/connector-fields'
import { ActionButton, Field } from '@/components/form'
import { useT } from '@/i18n/use-t'
import type { ConnectorField } from '@/lib/connector-form'
import { addConnectionAction } from '../actions'

export function NewConnectionForm({
  connectorId,
  configFields,
  credentialsFields,
}: {
  connectorId: string
  configFields: ConnectorField[]
  credentialsFields: ConnectorField[]
}) {
  const t = useT()
  return (
    <ActionForm action={addConnectionAction} className="space-y-4">
      {(state) => (
        <>
          <input type="hidden" name="connectorId" value={connectorId} />
          <Field name="name" label={t('connections.new.name')} required maxLength={100} defaultValue={state.values?.name ?? ''} error={state.fieldErrors?.name} hint={t('connections.new.nameHint')} />
          {configFields.length > 0 ? (
            <fieldset className="space-y-4">
              <legend className="text-sm font-semibold">{t('connections.new.settings')}</legend>
              <ConnectorFields fields={configFields} values={state.values} errors={state.fieldErrors} />
            </fieldset>
          ) : null}
          {credentialsFields.length > 0 ? (
            <fieldset className="space-y-4">
              <legend className="text-sm font-semibold">{t('connections.new.credentials')}</legend>
              <p className="text-xs text-muted">{t('connections.new.credentialsNote')}</p>
              <ConnectorFields fields={credentialsFields} errors={state.fieldErrors} />
            </fieldset>
          ) : null}
          <ActionButton pendingLabel={t('connections.new.submitting')}>{t('connections.new.submit')}</ActionButton>
        </>
      )}
    </ActionForm>
  )
}
