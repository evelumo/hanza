'use server'

import {
  cancelShipment,
  changeOrderStatus,
  findProductBySku,
  linkOrderLine,
  listShippingConnections,
  moveReservation,
  requestShipment,
  requestShipmentCheck,
  resolveAttention,
} from '@hanza/core'
import { getT } from '@/i18n/server'
import { failure, formText, invalidInput, type ActionState } from '@/lib/action-state'
import { getContext } from '@/lib/context'
import { domainErrorMessage } from '@/lib/domain-errors'
import { revalidateCatalogAndOrders, revalidateOrders } from '@/lib/revalidate'
import { requireTenant } from '@/lib/session'
import {
  changeOrderStatusSchema,
  createShipmentSchema,
  linkOrderLineSchema,
  moveReservationSchema,
  resolveAttentionSchema,
  shipmentActionSchema,
} from '../schemas'
import { shipmentFormSchema } from '../shipment-form'

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

export async function createShipmentAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const values = formText(formData)
  const base = createShipmentSchema.safeParse(values)
  if (!base.success) return invalidInput(base.error, t, values)

  const ctx = getContext()
  const { orderId, connectionId } = base.data
  // The service says which fields the form has, and the Order whether the Carrier collects money for it: both are
  // read here, in the organization, and never taken from the browser.
  const [connections, order] = await Promise.all([
    listShippingConnections(ctx, organizationId),
    ctx.db.order.findFirst({ where: { id: orderId, organizationId }, select: { payment: true, currency: true } }),
  ])
  const connection = connections.find((candidate) => candidate.id === connectionId)
  if (!order || !connection) return { error: domainErrorMessage(t, 'not_found'), values }
  const service = connection.services.find((candidate) => candidate.id === base.data.service)
  if (!service) return { error: domainErrorMessage(t, 'shipment_service_unknown'), values }
  const parsed = shipmentFormSchema(service, order.payment === 'cash_on_delivery' ? order.currency : null).safeParse(values)
  if (!parsed.success) return invalidInput(parsed.error, t, values)

  try {
    await requestShipment(ctx, organizationId, orderId, { connectionId, service: service.id, ...parsed.data }, { type: 'user', userId: user.id })
  } catch (error) {
    return failure(error, t, { values })
  }
  revalidateOrders()
  return { ok: true }
}

export async function cancelShipmentAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const parsed = shipmentActionSchema.safeParse(formText(formData))
  if (!parsed.success) return invalidInput(parsed.error, t)

  try {
    await cancelShipment(getContext(), organizationId, parsed.data.shipmentId, { type: 'user', userId: user.id })
  } catch (error) {
    return failure(error, t)
  }
  revalidateOrders()
  return { ok: true }
}

/** "Check status": the worker asks the Carrier now; the page shows the answer on its next load. */
export async function checkShipmentAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { organizationId } = await requireTenant()
  const t = await getT()
  const parsed = shipmentActionSchema.safeParse(formText(formData))
  if (!parsed.success) return invalidInput(parsed.error, t)

  try {
    await requestShipmentCheck(getContext(), organizationId, parsed.data.shipmentId)
  } catch (error) {
    return failure(error, t)
  }
  return { ok: true }
}
