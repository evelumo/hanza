'use client'

import { useActionState } from 'react'
import { ActionButton, Field, FormError } from '@/components/form'
import { useT } from '@/i18n/use-t'
import { eraseBuyerDataAction, previewErasureAction, type ErasureState } from './actions'

type Preview = NonNullable<ErasureState['preview']>

/** Two steps: find the Orders of one email, then confirm. The confirmation is a separate form, so it cannot nest. */
export function ErasureForm() {
  const t = useT()
  const [state, findAction] = useActionState(previewErasureAction, {} as ErasureState)

  return (
    <div className="space-y-4">
      <form action={findAction} className="flex flex-wrap items-end gap-3">
        <div className="w-full max-w-md">
          <Field
            name="email"
            label={t('privacy.erasure.emailLabel')}
            type="email"
            autoComplete="off"
            required
            maxLength={320}
            defaultValue={state.values?.email}
            error={state.fieldErrors?.email}
          />
        </div>
        <ActionButton variant="secondary" pendingLabel={t('privacy.erasure.finding')}>
          {t('privacy.erasure.find')}
        </ActionButton>
        <div className="basis-full">
          <FormError message={state.error ?? null} />
        </div>
      </form>

      {/* Keyed so a new search starts a new confirmation. */}
      {state.preview ? <ErasureConfirmation key={JSON.stringify(state.preview)} preview={state.preview} /> : null}
    </div>
  )
}

function ErasureConfirmation({ preview }: { preview: Preview }) {
  const t = useT()
  const [state, eraseAction] = useActionState(eraseBuyerDataAction, {} as ErasureState)
  const result = state.result

  return (
    <div role="status" className="space-y-3 rounded-md border border-line bg-canvas px-4 py-3 text-sm">
      {result ? (
        <>
          <p className="font-medium text-green-800">{t('privacy.erasure.done', { count: result.erased })}</p>
          {result.keptOpen > 0 ? <p>{t('privacy.erasure.openKept', { count: result.keptOpen })}</p> : null}
        </>
      ) : preview.closed === 0 && preview.open === 0 ? (
        <p>{t('privacy.erasure.noMatch')}</p>
      ) : (
        <>
          <p>{t('privacy.erasure.previewClosed', { count: preview.closed })}</p>
          {preview.open > 0 ? <p>{t('privacy.erasure.openKept', { count: preview.open })}</p> : null}
          {preview.closed > 0 ? (
            <form
              action={eraseAction}
              className="space-y-2"
              onSubmit={(event) => {
                if (!window.confirm(t('privacy.erasure.confirm'))) event.preventDefault()
              }}
            >
              <input type="hidden" name="email" value={preview.email} />
              <ActionButton variant="danger" pendingLabel={t('privacy.erasure.erasing')}>
                {t('privacy.erasure.submit')}
              </ActionButton>
              <FormError message={state.error ?? null} />
            </form>
          ) : null}
        </>
      )}
    </div>
  )
}
