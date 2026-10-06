'use client'

import { ActionForm } from '@/components/action-form'
import { ActionButton, Field } from '@/components/form'
import { useT } from '@/i18n/use-t'
import { createFamilyAction } from '../actions'

export function NewFamilyForm() {
  const t = useT()
  return (
    <ActionForm action={createFamilyAction} className="space-y-4">
      {(state) => (
        <>
          <Field name="name" label={t('families.new.name')} required maxLength={100} defaultValue={state.values?.name ?? ''} error={state.fieldErrors?.name} />
          <Field
            name="attributes"
            label={t('families.new.attributes')}
            required
            defaultValue={state.values?.attributes ?? ''}
            error={state.fieldErrors?.attributes}
            hint={t('families.new.attributesHint')}
          />
          <ActionButton pendingLabel={t('families.new.submitting')}>{t('families.new.submit')}</ActionButton>
        </>
      )}
    </ActionForm>
  )
}
