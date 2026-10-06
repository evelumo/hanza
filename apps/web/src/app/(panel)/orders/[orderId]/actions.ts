'use server'

import { changeOrderStatus, findProductBySku, linkOrderLine, moveReservation, resolveAttention } from '@hanza/core'
import { getT } from '@/i18n/server'
import { failure, formText, invalidInput, type ActionState } from '@/lib/action-state'
import { getContext } from '@/lib/context'
import { revalidateCatalogAndOrders } from '@/lib/revalidate'
import { requireTenant } from '@/lib/session'
import { changeOrderStatusSchema, linkOrderLineSchema, moveReservationSchema, resolveAttentionSchema } from '../schemas'

export async function changeOrderStatusAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const parsed = changeOrderStatusSchema.safeParse(formText(formData))
  if (!parsed.success) return invalidInput(parsed.error, t)

  try {
    await changeOrderStatus(getContext(), organizationId, parsed.data.orderId, { statusId: parsed.data.statusId }, { type: 'user', userId: user.id })
  } catch (error) {
    return failure(error, t)
  }
  revalidateCatalogAndOrders()
  return { ok: true }
}

export async function linkOrderLineAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const values = formText(formData)
  const parsed = linkOrderLineSchema.safeParse(values)
  if (!parsed.success) return invalidInput(parsed.error, t, values)

  const ctx = getContext()
  try {
    const product = await findProductBySku(ctx, organizationId, parsed.data.sku)
    if (!product) return { error: t('errors.unknownSku'), values }
    await linkOrderLine(ctx, organizationId, parsed.data.orderLineId, product.id, { type: 'user', userId: user.id })
  } catch (error) {
    return failure(error, t, { values })
  }
  revalidateCatalogAndOrders()
  return { ok: true }
}

export async function moveReservationAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const parsed = moveReservationSchema.safeParse(formText(formData))
  if (!parsed.success) return invalidInput(parsed.error, t)

  try {
    await moveReservation(getContext(), organizationId, parsed.data.orderLineId, parsed.data.warehouseId, { type: 'user', userId: user.id })
  } catch (error) {
    return failure(error, t)
  }
  revalidateCatalogAndOrders()
  return { ok: true }
}

export async function resolveAttentionAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const parsed = resolveAttentionSchema.safeParse(formText(formData))
  if (!parsed.success) return invalidInput(parsed.error, t)

  try {
    await resolveAttention(getContext(), organizationId, parsed.data.orderId, { type: 'user', userId: user.id })
  } catch (error) {
    return failure(error, t)
  }
  revalidateCatalogAndOrders()
  return { ok: true }
}
