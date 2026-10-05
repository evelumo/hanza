'use server'

import { createWarehouse, deleteWarehouse, setWarehouseActive, updateWarehouse } from '@hanza/core'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getT } from '@/i18n/server'
import { failure, formText, invalidInput, type ActionState } from '@/lib/action-state'
import { getContext } from '@/lib/context'
import { revalidateCatalogAndOrders } from '@/lib/revalidate'
import { requireTenant } from '@/lib/session'
import { createWarehouseSchema, setWarehouseActiveSchema, updateWarehouseSchema, warehouseIdSchema } from './schemas'

function revalidateWarehouses(): void {
  revalidatePath('/warehouses', 'layout')
  revalidatePath('/connections', 'layout')
  revalidateCatalogAndOrders()
}

export async function createWarehouseAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const values = formText(formData)
  const parsed = createWarehouseSchema.safeParse(values)
  if (!parsed.success) return invalidInput(parsed.error, t, values)

  let warehouseId: string
  try {
    ;({ warehouseId } = await createWarehouse(
      getContext(),
      organizationId,
      { name: parsed.data.name, priority: parsed.data.priority ?? undefined },
      { type: 'user', userId: user.id },
    ))
  } catch (error) {
    return failure(error, t, { values })
  }
  revalidateWarehouses()
  redirect(`/warehouses/${warehouseId}`)
}

export async function updateWarehouseAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const values = formText(formData)
  const parsed = updateWarehouseSchema.safeParse(values)
  if (!parsed.success) return invalidInput(parsed.error, t, values)

  const { warehouseId, name, priority } = parsed.data
  try {
    await updateWarehouse(getContext(), organizationId, warehouseId, { name, priority }, { type: 'user', userId: user.id })
  } catch (error) {
    return failure(error, t, { values })
  }
  revalidateWarehouses()
  return { ok: true }
}

export async function setWarehouseActiveAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const parsed = setWarehouseActiveSchema.safeParse(formText(formData))
  if (!parsed.success) return invalidInput(parsed.error, t)

  try {
    await setWarehouseActive(getContext(), organizationId, parsed.data.warehouseId, parsed.data.active, { type: 'user', userId: user.id })
  } catch (error) {
    return failure(error, t)
  }
  revalidateWarehouses()
  return { ok: true }
}

export async function deleteWarehouseAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const parsed = warehouseIdSchema.safeParse(formText(formData))
  if (!parsed.success) return invalidInput(parsed.error, t)

  try {
    await deleteWarehouse(getContext(), organizationId, parsed.data.warehouseId, { type: 'user', userId: user.id })
  } catch (error) {
    return failure(error, t)
  }
  revalidateWarehouses()
  redirect('/warehouses')
}
