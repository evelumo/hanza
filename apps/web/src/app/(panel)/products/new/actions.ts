'use server'

import { createProduct } from '@hanza/core'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { failure, formText, invalidInput, type ActionState } from '@/lib/action-state'
import { getContext } from '@/lib/context'
import { requireTenant } from '@/lib/session'
import { createProductSchema } from '../schemas'

export async function createProductAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const values = formText(formData)
  const parsed = createProductSchema.safeParse(values)
  if (!parsed.success) return invalidInput(parsed.error, values)

  let productId: string
  try {
    ;({ productId } = await createProduct(getContext(), organizationId, parsed.data, { type: 'user', userId: user.id }))
  } catch (error) {
    return failure(error, { values })
  }
  revalidatePath('/products', 'layout')
  redirect(`/products/${productId}`)
}
