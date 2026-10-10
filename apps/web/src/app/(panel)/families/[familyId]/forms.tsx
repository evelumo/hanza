'use client'

import { ActionForm } from '@/components/action-form'
import { ActionButton, BesideFields, Field } from '@/components/form'
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
    <ActionForm
      action={renameFamilyAction}
      success={t('common.saved')}
      className="grid gap-3"
      actions={<ActionButton variant="secondary">{t('families.detail.saveName')}</ActionButton>}
    >
      {(state) => (
        <>
          <input type="hidden" name="familyId" value={familyId} />
          <Field name="name" label={t('families.detail.name')} required maxLength={100} defaultValue={state.values?.name ?? name} error={state.fieldErrors?.name} />
        </>
      )}
    </ActionForm>
  )
}

/**
 * The values of one product, one compact field per attribute and one Save. The label stays visible: the values
 * share a table cell, so a column header cannot say which attribute a field is.
 */
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
    <ActionForm action={updateFamilyMemberAction} success={t('common.saved')} className="grid gap-2">
      {(state) => (
        <>
          <input type="hidden" name="productId" value={productId} />
          <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
            {attributes.map((attribute, index) => {
              const field = (
                <div key={attribute.name} className="w-32">
                  <Field
                    name={valueField(index)}
                    label={attribute.name}
                    aria-label={t('families.detail.valueLabel', { attribute: attribute.name, sku })}
                    compact
                    required
                    maxLength={100}
                    defaultValue={state.values?.[valueField(index)] ?? attribute.value}
                    error={state.fieldErrors?.[valueField(index)]}
                  />
                </div>
              )
              if (index < attributes.length - 1) return field
              // The button stays beside the last field, so where the row wraps it never lands on a line of its own.
              return (
                <div key={attribute.name} className="flex items-start gap-3">
                  {field}
                  <BesideFields>
                    <ActionButton variant="secondary" size="sm" pendingLabel={t('families.detail.saving')}>
                      {t('families.detail.saveValues')}
                    </ActionButton>
                  </BesideFields>
                </div>
              )
            })}
          </div>
        </>
      )}
    </ActionForm>
  )
}

export function RemoveMemberForm({ productId }: { productId: string }) {
  const t = useT()
  return (
    <ActionForm action={removeProductFromFamilyAction} confirm={t('families.detail.removeConfirm')} className="grid gap-2">
      <input type="hidden" name="productId" value={productId} />
      {/* On the line of the value fields in the same row, like the button that saves them; in a narrow row it has a line of its own. */}
      <BesideFields labelClassName="@max-2xl/table:hidden">
        <ActionButton variant="danger" size="sm" pendingLabel={t('families.detail.removing')}>
          {t('families.detail.remove')}
        </ActionButton>
      </BesideFields>
    </ActionForm>
  )
}

export function AddProductForm({ familyId, attributes }: { familyId: string; attributes: string[] }) {
  const t = useT()
  return (
    <ActionForm
      action={addProductToFamilyAction}
      success={t('common.saved')}
      className="grid gap-4"
      actions={
        <ActionButton variant="secondary" pendingLabel={t('families.detail.adding')}>
          {t('families.detail.add')}
        </ActionButton>
      }
    >
      {(state) => (
        <>
          <input type="hidden" name="familyId" value={familyId} />
          <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
            <Field
              name="sku"
              label={t('families.detail.sku')}
              required
              maxLength={64}
              defaultValue={state.values?.sku ?? ''}
              error={state.fieldErrors?.sku}
              hint={t('families.detail.skuHint')}
              className="font-mono"
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
        </>
      )}
    </ActionForm>
  )
}

export function DeleteFamilyForm({ familyId }: { familyId: string }) {
  const t = useT()
  return (
    <ActionForm action={deleteFamilyAction} confirm={t('families.detail.deleteConfirm')} className="grid justify-items-start gap-2">
      <input type="hidden" name="familyId" value={familyId} />
      <ActionButton variant="danger" pendingLabel={t('families.detail.deleting')}>
        {t('families.detail.delete')}
      </ActionButton>
    </ActionForm>
  )
}
