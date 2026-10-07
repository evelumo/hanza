'use server'

import { retryOfferPush, setOfferPrice } from '@hanza/core'
import { revalidatePath } from 'next/cache'
import { getT } from '@/i18n/server'
import { failure, formText, invalidInput, type ActionState } from '@/lib/action-state'
import { getContext } from '@/lib/context'
import { requireTenant } from '@/lib/session'
import { priceFromForm, retryOfferPushSchema, setOfferPriceSchema } from '../../schemas'

export async function setOfferPriceAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const values = formText(formData)
  const parsed = setOfferPriceSchema.safeParse(values)
  if (!parsed.success) return invalidInput(parsed.error, t, values)

  try {
    await setOfferPrice(getContext(), organizationId, parsed.data.offerId, priceFromForm(parsed.data), { type: 'user', userId: user.id })
  } catch (error) {
    return failure(error, t, { values })
  }
  revalidatePath('/products', 'layout')
  return { ok: true }
}

/** Sends a rejected stock or price push again (#68). */
export async function retryOfferPushAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const parsed = retryOfferPushSchema.safeParse(formText(formData))
  if (!parsed.success) return invalidInput(parsed.error, t)

  try {
    await retryOfferPush(getContext(), organizationId, parsed.data.offerId, parsed.data.push, { type: 'user', userId: user.id })
  } catch (error) {
    return failure(error, t)
  }
  revalidatePath('/products', 'layout')
  revalidatePath('/connections', 'layout')
  return { ok: true }
}
