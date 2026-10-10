'use client'

import { useActionState } from 'react'
import { ActionForm } from '@/components/action-form'
import { DescriptionItem, DescriptionList } from '@/components/description-list'
import { ActionButton, Field, FormError, FormSuccess } from '@/components/form'
import { Notice } from '@/components/notice'
import { useT } from '@/i18n/use-t'
import { eraseBuyerDataAction, previewErasureAction, type ErasureState } from './actions'
import { useResultKey } from './use-result-key'

type Preview = NonNullable<ErasureState['preview']>

/** Two steps: find the Orders of one email, then confirm. The confirmation is a separate form, so it cannot nest. */
export function ErasureForm() {
  const t = useT()
  const [state, findAction] = useActionState(previewErasureAction, {} as ErasureState)
  const round = useResultKey(state)

  return (
    <div>
      <form action={findAction} className="flex flex-col items-start gap-3">
        <div className="w-full max-w-lg">
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
        <FormError message={state.error ?? null} />
        <ActionButton variant="secondary" pendingLabel={t('privacy.erasure.finding')}>
          {t('privacy.erasure.find')}
        </ActionButton>
      </form>

      {/* Mounted before it has anything to say, so a screen reader announces what a search finds; it takes no room until then. */}
      <div aria-live="polite" className="*:mt-4">
        {state.preview ? <ErasureReview key={round} preview={state.preview} /> : null}
      </div>
    </div>
  )
}

function ErasureReview({ preview }: { preview: Preview }) {
  const t = useT()
  const erases = preview.closed > 0

  if (!erases && preview.open === 0) return <Notice tone="neutral">{t('privacy.erasure.noMatch')}</Notice>

  return (
    <ActionForm action={eraseBuyerDataAction} confirm={erases ? t('privacy.erasure.confirm', { count: preview.closed }) : undefined} className="grid gap-3">
      {({ result }) =>
        result ? (
          <div className="grid gap-3">
            <FormSuccess message={t('privacy.erasure.done', { count: result.erased })} />
            {result.keptOpen > 0 ? <Notice tone="info">{t('privacy.erasure.openKept', { count: result.keptOpen })}</Notice> : null}
          </div>
        ) : (
          <Notice
            tone={erases ? 'warning' : 'info'}
            title={t('privacy.erasure.reviewTitle')}
            actions={
              erases ? (
                <>
                  <input type="hidden" name="email" value={preview.email} />
                  <ActionButton variant="danger" pendingLabel={t('privacy.erasure.erasing')}>
                    {t('privacy.erasure.submit')}
                  </ActionButton>
                </>
              ) : undefined
            }
          >
            <p className="font-medium">{t('privacy.erasure.previewClosed', { count: preview.closed })}</p>
            {erases ? (
              <>
                <DescriptionList>
                  <DescriptionItem term={t('privacy.erasure.erasedTerm')}>{t('privacy.erasure.erasedBody')}</DescriptionItem>
                  <DescriptionItem term={t('privacy.erasure.keptTerm')}>{t('privacy.erasure.keptBody')}</DescriptionItem>
                </DescriptionList>
                <p className="font-medium">{t('privacy.erasure.irreversible')}</p>
              </>
            ) : null}
            {preview.open > 0 ? <p>{t('privacy.erasure.openKept', { count: preview.open })}</p> : null}
          </Notice>
        )
      }
    </ActionForm>
  )
}
