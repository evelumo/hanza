'use server'

import { setOfferPrice } from '@hanza/core'
import { revalidatePath } from 'next/cache'
import { getT } from '@/i18n/server'
import { failure, formText, invalidInput, type ActionState } from '@/lib/action-state'
import { getContext } from '@/lib/context'
import { requireTenant } from '@/lib/session'
import { priceFromForm, setOfferPriceSchema } from '../../schemas'

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
