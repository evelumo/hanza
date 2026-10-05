'use server'

import { setStock, unlinkOffer, updateProduct } from '@hanza/core'
import { revalidatePath } from 'next/cache'
import { failure, formText, invalidInput, type ActionState } from '@/lib/action-state'
import { getContext } from '@/lib/context'
import { requireTenant } from '@/lib/session'
import { setStockSchema, unlinkOfferSchema, updateProductSchema } from '../schemas'

export async function updateProductAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const values = formText(formData)
  const parsed = updateProductSchema.safeParse(values)
  if (!parsed.success) return invalidInput(parsed.error, values)

  try {
    await updateProduct(getContext(), organizationId, parsed.data.productId, { name: parsed.data.name }, { type: 'user', userId: user.id })
  } catch (error) {
    return failure(error, { values })
  }
  revalidatePath('/products', 'layout')
  return { ok: true }
}

export async function setStockAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const values = formText(formData)
  const parsed = setStockSchema.safeParse(values)
  if (!parsed.success) return invalidInput(parsed.error, values)

  try {
    await setStock(getContext(), organizationId, parsed.data.productId, parsed.data.stock, { type: 'user', userId: user.id })
  } catch (error) {
    return failure(error, { values })
  }
  revalidatePath('/products', 'layout')
  return { ok: true }
}

export async function unlinkOfferAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const parsed = unlinkOfferSchema.safeParse(formText(formData))
  if (!parsed.success) return invalidInput(parsed.error)

  try {
    await unlinkOffer(getContext(), organizationId, parsed.data.offerId, { type: 'user', userId: user.id })
  } catch (error) {
    return failure(error)
  }
  revalidatePath('/products', 'layout')
  return { ok: true }
}
