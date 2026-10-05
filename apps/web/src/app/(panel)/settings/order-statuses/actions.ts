'use server'

import {
  createOrderStatus,
  deleteOrderStatus,
  makeDefaultOrderStatus,
  moveOrderStatus,
  setOrderStatusActive,
  updateOrderStatus,
  type Actor,
} from '@hanza/core'
import { revalidatePath } from 'next/cache'
import type { z } from 'zod'
import { getT } from '@/i18n/server'
import { failure, formText, invalidInput, type ActionState } from '@/lib/action-state'
import { getContext } from '@/lib/context'
import { requireTenant } from '@/lib/session'
import {
  createOrderStatusSchema,
  deleteOrderStatusSchema,
  moveOrderStatusSchema,
  orderStatusIdSchema,
  setOrderStatusActiveSchema,
  updateOrderStatusSchema,
} from './schemas'

// Every service called here refuses anyone but an owner or admin (`forbidden`); the page only hides the forms.

/** Parses the form, runs the service as the signed-in person and refreshes every page that shows statuses. */
async function run<S extends z.ZodType>(
  schema: S,
  formData: FormData,
  service: (organizationId: string, input: z.output<S>, actor: Actor) => Promise<unknown>,
): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const values = formText(formData)
  const parsed = schema.safeParse(values)
  if (!parsed.success) return invalidInput(parsed.error, t, values)
  try {
    await service(organizationId, parsed.data, { type: 'user', userId: user.id })
  } catch (error) {
    return failure(error, t, { values })
  }
  revalidatePath('/settings', 'layout')
  revalidatePath('/orders', 'layout')
  revalidatePath('/connections', 'layout')
  return { ok: true }
}

export async function createOrderStatusAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  return run(createOrderStatusSchema, formData, (organizationId, input, actor) => createOrderStatus(getContext(), organizationId, input, actor))
}

export async function updateOrderStatusAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  return run(updateOrderStatusSchema, formData, (organizationId, { statusId, name, color }, actor) =>
    updateOrderStatus(getContext(), organizationId, statusId, { name, color }, actor),
  )
}

export async function moveOrderStatusAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  return run(moveOrderStatusSchema, formData, (organizationId, { statusId, direction }, actor) =>
    moveOrderStatus(getContext(), organizationId, statusId, direction, actor),
  )
}

export async function setOrderStatusActiveAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  return run(setOrderStatusActiveSchema, formData, (organizationId, { statusId, active }, actor) =>
    setOrderStatusActive(getContext(), organizationId, statusId, active, actor),
  )
}

export async function makeDefaultOrderStatusAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  return run(orderStatusIdSchema, formData, (organizationId, { statusId }, actor) => makeDefaultOrderStatus(getContext(), organizationId, statusId, actor))
}

export async function deleteOrderStatusAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  return run(deleteOrderStatusSchema, formData, (organizationId, { statusId, replacementId }, actor) =>
    deleteOrderStatus(getContext(), organizationId, statusId, replacementId, actor),
  )
}
