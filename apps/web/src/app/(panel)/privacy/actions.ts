'use server'

import {
  eraseBuyerData,
  getPrivacySettings,
  previewBuyerDataRetention,
  previewBuyerErasure,
  retentionNeedsConfirmation,
  setBuyerDataRetention,
  type Actor,
} from '@hanza/core'
import { revalidatePath } from 'next/cache'
import { getT } from '@/i18n/server'
import { failure, formText, invalidInput, type ActionState } from '@/lib/action-state'
import { getContext } from '@/lib/context'
import { requireTenant } from '@/lib/session'
import { erasureSchema, retentionSchema } from './schemas'

// Every service called here refuses anyone but an owner or admin (`forbidden`).

export interface RetentionState extends ActionState {
  /** A new or shorter period: how many Orders the next check would erase, shown before anything is saved. */
  confirm?: { days: number; count: number }
}

export interface ErasureState extends ActionState {
  /** What confirming would do; carries the email back so the confirmation form can send it. */
  preview?: { email: string; closed: number; open: number }
  result?: { erased: number; keptOpen: number }
}

export async function setRetentionAction(_previous: RetentionState, formData: FormData): Promise<RetentionState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const values = formText(formData)
  const parsed = retentionSchema.safeParse(values)
  if (!parsed.success) return invalidInput(parsed.error, t, values)
  const actor: Actor = { type: 'user', userId: user.id }
  const ctx = getContext()
  const days = parsed.data.retentionDays

  try {
    const { buyerDataRetentionDays: current } = await getPrivacySettings(ctx, organizationId)
    if (days !== null && retentionNeedsConfirmation(current, days) && parsed.data.confirmed !== '1') {
      const { erasedAtNextCheck } = await previewBuyerDataRetention(ctx, organizationId, days, actor)
      return { values, confirm: { days, count: erasedAtNextCheck } }
    }
    await setBuyerDataRetention(ctx, organizationId, days, actor)
  } catch (error) {
    return failure(error, t, { values })
  }
  revalidatePath('/privacy')
  return { ok: true }
}

export async function previewErasureAction(_previous: ErasureState, formData: FormData): Promise<ErasureState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const values = formText(formData)
  const parsed = erasureSchema.safeParse(values)
  if (!parsed.success) return invalidInput(parsed.error, t, values)

  try {
    const preview = await previewBuyerErasure(getContext(), organizationId, parsed.data.email, { type: 'user', userId: user.id })
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
