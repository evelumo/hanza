'use client'

import { ActionForm } from '@/components/action-form'
import { ConnectorFields } from '@/components/connector-fields'
import { ActionButton, Field } from '@/components/form'
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
  return (
    <ActionForm action={addConnectionAction} className="space-y-4">
      {(state) => (
        <>
          <input type="hidden" name="connectorId" value={connectorId} />
          <Field name="name" label="Nazwa" required maxLength={100} defaultValue={state.values?.name ?? ''} error={state.fieldErrors?.name} hint="Pod tą nazwą połączenie pojawi się w panelu." />
          {configFields.length > 0 ? (
            <fieldset className="space-y-4">
              <legend className="text-sm font-semibold">Ustawienia</legend>
              <ConnectorFields fields={configFields} values={state.values} errors={state.fieldErrors} />
            </fieldset>
          ) : null}
          {credentialsFields.length > 0 ? (
            <fieldset className="space-y-4">
              <legend className="text-sm font-semibold">Dane dostępowe</legend>
              <p className="text-xs text-muted">Przechowujemy je zaszyfrowane i nie pokazujemy ich ponownie.</p>
              <ConnectorFields fields={credentialsFields} errors={state.fieldErrors} />
            </fieldset>
          ) : null}
          <ActionButton pendingLabel="Dodawanie…">Dodaj połączenie</ActionButton>
        </>
      )}
    </ActionForm>
  )
}
