'use client'

import Link from 'next/link'
import { ActionForm } from '@/components/action-form'
import { buttonClass } from '@/components/button-class'
import { ConnectorFields } from '@/components/connector-fields'
import { ActionButton, Field, RadioGroupField } from '@/components/form'
import { Notice } from '@/components/notice'
import { useT } from '@/i18n/use-t'
import type { ConnectorField } from '@/lib/connector-form'
import { addConnectionAction, startSignInAction } from '../actions'

// The rule sits on a wrapper: a border on the fieldset itself would be drawn through its legend.
const groupClass = 'border-t border-border pt-4'

export function NewConnectionForm({
  connectorId,
  configFields,
  credentialsFields,
  signIn,
}: {
  connectorId: string
  configFields: ConnectorField[]
  credentialsFields: ConnectorField[]
  /** Set for a connector with a device-flow sign-in: the form starts the sign-in instead of adding the Connection. */
  signIn: { connector: string } | null
}) {
  const t = useT()
  return (
    <ActionForm
      action={signIn ? startSignInAction : addConnectionAction}
      className="grid gap-4"
      actions={
        <>
          {signIn ? (
            <ActionButton pendingLabel={t('connections.new.startingSignIn')}>{t('connections.new.continueToSignIn')}</ActionButton>
          ) : (
            <ActionButton pendingLabel={t('connections.new.submitting')}>{t('connections.new.submit')}</ActionButton>
          )}
          <Link href="/connections" className={buttonClass('secondary')}>
            {t('common.cancel')}
          </Link>
        </>
      }
    >
      {(state) => (
        <>
          <input type="hidden" name="connectorId" value={connectorId} />
          <Field
            name="name"
            label={t('connections.new.name')}
            required
            maxLength={100}
            defaultValue={state.values?.name ?? ''}
            error={state.fieldErrors?.name}
            hint={t('connections.new.nameHint')}
          />
          {configFields.length > 0 ? (
            <div className={groupClass}>
              <RadioGroupField legend={t('connections.new.settings')} className="gap-4">
                <ConnectorFields fields={configFields} values={state.values} errors={state.fieldErrors} />
              </RadioGroupField>
            </div>
          ) : null}
          {credentialsFields.length > 0 ? (
            <div className={groupClass}>
              <RadioGroupField legend={t('connections.new.credentials')} hint={t('connections.new.credentialsNote')} className="gap-4">
                <ConnectorFields fields={credentialsFields} errors={state.fieldErrors} />
              </RadioGroupField>
            </div>
          ) : null}
          {signIn ? <Notice>{t('connections.new.signInNote', { connector: signIn.connector })}</Notice> : null}
        </>
      )}
    </ActionForm>
  )
}
