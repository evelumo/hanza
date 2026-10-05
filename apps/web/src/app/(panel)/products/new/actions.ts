'use server'

import { createProduct } from '@hanza/core'
import { redirect } from 'next/navigation'
import { getT } from '@/i18n/server'
import { failure, formText, invalidInput, type ActionState } from '@/lib/action-state'
import { getContext } from '@/lib/context'
import { revalidateCatalogAndOrders } from '@/lib/revalidate'
import { requireTenant } from '@/lib/session'
import { createProductSchema } from '../schemas'

export async function createProductAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const values = formText(formData)
  const parsed = createProductSchema.safeParse(values)
  if (!parsed.success) return invalidInput(parsed.error, t, values)

  let productId: string
  try {
    ;({ productId } = await createProduct(getContext(), organizationId, parsed.data, { type: 'user', userId: user.id }))
  } catch (error) {
    return failure(error, t, { values })
  }
  revalidateCatalogAndOrders()
  redirect(`/products/${productId}`)
}
