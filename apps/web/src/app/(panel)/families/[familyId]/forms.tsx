'use client'

import { ActionForm } from '@/components/action-form'
import { ActionButton, Field } from '@/components/form'
import { useT } from '@/i18n/use-t'
import { valueField } from '../value-field'
import {
  addProductToFamilyAction,
  deleteFamilyAction,
  removeProductFromFamilyAction,
  renameFamilyAction,
  updateFamilyMemberAction,
} from './actions'

export function RenameForm({ familyId, name }: { familyId: string; name: string }) {
  const t = useT()
  return (
    <ActionForm action={renameFamilyAction} success={t('common.saved')} className="flex flex-wrap items-end gap-3">
      {(state) => (
        <>
          <input type="hidden" name="familyId" value={familyId} />
          <div className="w-full max-w-md">
            <Field name="name" label={t('families.detail.name')} required maxLength={100} defaultValue={state.values?.name ?? name} error={state.fieldErrors?.name} />
          </div>
          <ActionButton>{t('families.detail.saveName')}</ActionButton>
        </>
      )}
    </ActionForm>
  )
}

export function MemberValuesForm({
  productId,
  sku,
  attributes,
}: {
  productId: string
  sku: string
  attributes: Array<{ name: string; value: string }>
}) {
  const t = useT()
  return (
    <ActionForm action={updateFamilyMemberAction} success={t('common.saved')} className="space-y-2">
      {(state) => (
        <>
          <input type="hidden" name="productId" value={productId} />
          <div className="flex flex-wrap items-end gap-3">
            {attributes.map((attribute, index) => (
              <div key={attribute.name} className="w-40">
                <Field
                  name={valueField(index)}
                  label={attribute.name}
                  aria-label={t('families.detail.valueLabel', { attribute: attribute.name, sku })}
                  required
                  maxLength={100}
                  defaultValue={state.values?.[valueField(index)] ?? attribute.value}
                  error={state.fieldErrors?.[valueField(index)]}
                />
              </div>
            ))}
            <ActionButton variant="secondary" pendingLabel={t('families.detail.saving')}>
              {t('families.detail.saveValues')}
            </ActionButton>
          </div>
        </>
      )}
    </ActionForm>
  )
}

export function RemoveMemberForm({ productId }: { productId: string }) {
  const t = useT()
  return (
    <ActionForm action={removeProductFromFamilyAction} confirm={t('families.detail.removeConfirm')}>
      <input type="hidden" name="productId" value={productId} />
      <ActionButton variant="secondary" pendingLabel={t('families.detail.removing')}>
        {t('families.detail.remove')}
      </ActionButton>
    </ActionForm>
  )
}

export function AddProductForm({ familyId, attributes }: { familyId: string; attributes: string[] }) {
  const t = useT()
  return (
    <ActionForm action={addProductToFamilyAction} success={t('common.saved')} className="space-y-4">
      {(state) => (
        <>
          <input type="hidden" name="familyId" value={familyId} />
          <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
            <Field
              name="sku"
              label={t('families.detail.sku')}
              required
              maxLength={64}
              defaultValue={state.values?.sku ?? ''}
              error={state.fieldErrors?.sku}
              hint={t('families.detail.skuHint')}
            />
            {attributes.map((attribute, index) => (
              <Field
                key={attribute}
                name={valueField(index)}
                label={attribute}
                required
                maxLength={100}
                defaultValue={state.values?.[valueField(index)] ?? ''}
                error={state.fieldErrors?.[valueField(index)]}
              />
            ))}
          </div>
          <ActionButton pendingLabel={t('families.detail.adding')}>{t('families.detail.add')}</ActionButton>
        </>
      )}
    </ActionForm>
  )
}

export function DeleteFamilyForm({ familyId }: { familyId: string }) {
  const t = useT()
  return (
    <ActionForm action={deleteFamilyAction} confirm={t('families.detail.deleteConfirm')}>
      <input type="hidden" name="familyId" value={familyId} />
      <ActionButton variant="secondary" pendingLabel={t('families.detail.deleting')}>
        {t('families.detail.delete')}
      </ActionButton>
    </ActionForm>
  )
}
