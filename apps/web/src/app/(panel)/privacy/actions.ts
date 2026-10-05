'use server'

import { eraseBuyerData, previewBuyerErasure, setBuyerDataRetention } from '@hanza/core'
import { revalidatePath } from 'next/cache'
import { getT } from '@/i18n/server'
import { failure, formText, invalidInput, type ActionState } from '@/lib/action-state'
import { getContext } from '@/lib/context'
import { requireTenant } from '@/lib/session'
import { erasureSchema, retentionSchema } from './schemas'

export interface ErasureState extends ActionState {
  /** What confirming would do; carries the email back so the confirmation form can send it. */
  preview?: { email: string; closed: number; open: number }
  result?: { erased: number; keptOpen: number }
}

export async function setRetentionAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const values = formText(formData)
  const parsed = retentionSchema.safeParse(values)
  if (!parsed.success) return invalidInput(parsed.error, t, values)

  try {
    await setBuyerDataRetention(getContext(), organizationId, parsed.data.retentionDays, { type: 'user', userId: user.id })
  } catch (error) {
    return failure(error, t, { values })
  }
  revalidatePath('/privacy')
  return { ok: true }
}

export async function previewErasureAction(_previous: ErasureState, formData: FormData): Promise<ErasureState> {
  const { organizationId } = await requireTenant()
  const t = await getT()
  const values = formText(formData)
  const parsed = erasureSchema.safeParse(values)
  if (!parsed.success) return invalidInput(parsed.error, t, values)

  try {
    const preview = await previewBuyerErasure(getContext(), organizationId, parsed.data.email)
    return { values, preview: { email: parsed.data.email, ...preview } }
  } catch (error) {
    return failure(error, t, { values })
  }
}

export async function eraseBuyerDataAction(_previous: ErasureState, formData: FormData): Promise<ErasureState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const parsed = erasureSchema.safeParse(formText(formData))
  if (!parsed.success) return invalidInput(parsed.error, t)

  try {
    const result = await eraseBuyerData(getContext(), organizationId, parsed.data.email, { type: 'user', userId: user.id })
    revalidatePath('/orders', 'layout')
    return { ok: true, result }
  } catch (error) {
    return failure(error, t)
  }
}
