'use server'

import {
  addProductToFamily,
  deleteFamily,
  DomainError,
  findProductBySku,
  getFamilyAttributes,
  getProductFamilyAttributes,
  removeProductFromFamily,
  renameFamily,
  updateFamilyMember,
} from '@hanza/core'
import { redirect } from 'next/navigation'
import { getT } from '@/i18n/server'
import { failure, formText, invalidInput, translateIssue, type ActionState } from '@/lib/action-state'
import { getContext } from '@/lib/context'
import type { Translator } from '@/i18n/types'
import { revalidateFamilies } from '@/lib/revalidate'
import { requireTenant } from '@/lib/session'
import { addToFamilySchema, familyIdSchema, parseAttributeValues, productIdSchema, renameFamilySchema } from '../schemas'

function invalidValues(fieldErrors: Record<string, string>, t: Translator, values: Record<string, string>): ActionState {
  return {
    error: t('errors.invalidInput'),
    fieldErrors: Object.fromEntries(Object.entries(fieldErrors).map(([field, key]) => [field, translateIssue(key, t)])),
    values,
  }
}

export async function renameFamilyAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const values = formText(formData)
  const parsed = renameFamilySchema.safeParse(values)
  if (!parsed.success) return invalidInput(parsed.error, t, values)

  try {
    await renameFamily(getContext(), organizationId, parsed.data.familyId, parsed.data.name, { type: 'user', userId: user.id })
  } catch (error) {
    return failure(error, t, { values })
  }
  revalidateFamilies()
  return { ok: true }
}

export async function deleteFamilyAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const parsed = familyIdSchema.safeParse(formText(formData))
  if (!parsed.success) return invalidInput(parsed.error, t)

  try {
    await deleteFamily(getContext(), organizationId, parsed.data.familyId, { type: 'user', userId: user.id })
  } catch (error) {
    return failure(error, t)
  }
  revalidateFamilies()
  redirect('/families')
}

export async function addProductToFamilyAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const input = formText(formData)
  const parsed = addToFamilySchema.safeParse(input)
  if (!parsed.success) return invalidInput(parsed.error, t, input)

  const ctx = getContext()
  try {
    const familyAttributes = await getFamilyAttributes(ctx, organizationId, parsed.data.familyId)
    if (!familyAttributes) throw new DomainError('not_found')
    const attributes = parseAttributeValues(familyAttributes, input)
    if (!attributes.ok) return invalidValues(attributes.fieldErrors, t, input)
    const product = await findProductBySku(ctx, organizationId, parsed.data.sku)
    if (!product) return { error: t('errors.unknownSku'), fieldErrors: { sku: t('errors.unknownSku') }, values: input }
    await addProductToFamily(ctx, organizationId, parsed.data.familyId, product.id, attributes.values, { type: 'user', userId: user.id })
  } catch (error) {
    return failure(error, t, { values: input })
  }
  revalidateFamilies()
  return { ok: true }
}

export async function updateFamilyMemberAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const input = formText(formData)
  const parsed = productIdSchema.safeParse(input)
  if (!parsed.success) return invalidInput(parsed.error, t, input)

  const ctx = getContext()
  try {
    const familyAttributes = await getProductFamilyAttributes(ctx, organizationId, parsed.data.productId)
    if (!familyAttributes) throw new DomainError('not_found')
    const attributes = parseAttributeValues(familyAttributes, input)
    if (!attributes.ok) return invalidValues(attributes.fieldErrors, t, input)
    await updateFamilyMember(ctx, organizationId, parsed.data.productId, attributes.values, { type: 'user', userId: user.id })
  } catch (error) {
    return failure(error, t, { values: input })
  }
  revalidateFamilies()
  return { ok: true }
}

export async function removeProductFromFamilyAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const parsed = productIdSchema.safeParse(formText(formData))
  if (!parsed.success) return invalidInput(parsed.error, t)

  try {
    await removeProductFromFamily(getContext(), organizationId, parsed.data.productId, { type: 'user', userId: user.id })
  } catch (error) {
    return failure(error, t)
  }
  revalidateFamilies()
  return { ok: true }
}
