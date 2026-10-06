'use server'

import { createFamily } from '@hanza/core'
import { redirect } from 'next/navigation'
import { getT } from '@/i18n/server'
import { failure, formText, invalidInput, type ActionState } from '@/lib/action-state'
import { getContext } from '@/lib/context'
import { revalidateFamilies } from '@/lib/revalidate'
import { requireTenant } from '@/lib/session'
import { createFamilySchema } from './schemas'

export async function createFamilyAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const values = formText(formData)
  const parsed = createFamilySchema.safeParse(values)
  if (!parsed.success) return invalidInput(parsed.error, t, values)

  let familyId: string
  try {
    ;({ familyId } = await createFamily(getContext(), organizationId, parsed.data, { type: 'user', userId: user.id }))
  } catch (error) {
    return failure(error, t, { values })
  }
  revalidateFamilies()
  redirect(`/families/${familyId}`)
}
