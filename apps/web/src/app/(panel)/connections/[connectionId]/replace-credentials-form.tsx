'use client'

import { ActionForm } from '@/components/action-form'
import { ConnectorFields } from '@/components/connector-fields'
import { ActionButton } from '@/components/form'
import { useT } from '@/i18n/use-t'
import type { ConnectorField } from '@/lib/connector-form'
import { replaceCredentialsAction } from '../actions'

/**
 * The credentials fields of the create form, empty: the stored values never reach the page. `primary` while the
 * Connection waits for sign-in, when sending this form is the one thing to do on the page.
 */
export function ReplaceCredentialsForm({ connectionId, fields, primary }: { connectionId: string; fields: ConnectorField[]; primary: boolean }) {
  const t = useT()
  return (
    <ActionForm
      action={replaceCredentialsAction}
      success={t('connections.detail.credentials.replaced')}
      className="grid gap-4"
      actions={
        <ActionButton variant={primary ? 'primary' : 'secondary'} pendingLabel={t('connections.detail.credentials.replacing')}>
          {t('connections.detail.credentials.replace')}
        </ActionButton>
      }
    >
      {(state) => (
        <>
          <input type="hidden" name="connectionId" value={connectionId} />
          {/* The section is as wide as the page when the columns stack; a key does not need that. */}
          <div className="grid max-w-md gap-4">
            <ConnectorFields fields={fields} errors={state.fieldErrors} />
          </div>
        </>
      )}
    </ActionForm>
  )
}
