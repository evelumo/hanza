import { randomUUID } from 'node:crypto'
import type { Tx } from '@hanza/db'
import { z } from 'zod'
import type { Actor } from '../actor'
import type { Context } from '../context'
import { DomainError } from '../errors'
import { appendEvent } from '../events'
import { DEFAULT_WAREHOUSE_CODE, ensureDefaultWarehouse } from '../stock/warehouse'
import { TX_OPTIONS } from '../transaction'

export const warehouseInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  priority: z.number().int().min(0).max(1_000_000),
})

export type WarehouseInput = z.infer<typeof warehouseInputSchema>

export interface WarehouseRow {
  id: string
  name: string
  priority: number
  active: boolean
  isDefault: boolean
  /** Σ Stock in this Warehouse over all Products. */
  stock: number
  /** Σ units of open Reservations in this Warehouse. */
  reserved: number
  /** Channels that chose this Warehouse explicitly (a Channel counting every Warehouse is not listed). */
  channels: Array<{ id: string; name: string }>
}

/**
 * Every Warehouse of the organization in placement order (priority, then id), the default one
 * created first if missing.
 */
export async function listWarehouses(ctx: Context, organizationId: string): Promise<WarehouseRow[]> {
  await ensureDefaultWarehouse(ctx.db, organizationId)
  const rows = await ctx.db.warehouse.findMany({
    where: { organizationId },
    orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      name: true,
      priority: true,
      active: true,
      code: true,
      channelWarehouses: {
        where: { organizationId },
        orderBy: { connectionId: 'asc' },
        select: { connection: { select: { id: true, name: true } } },
      },
    },
  })
  const ids = rows.map((row) => row.id)
  const [stock, reserved] = await Promise.all([
    ctx.db.stock.groupBy({ by: ['warehouseId'], where: { organizationId, warehouseId: { in: ids } }, _sum: { units: true } }),
    ctx.db.reservation.groupBy({
      by: ['warehouseId'],
      where: { organizationId, warehouseId: { in: ids }, status: 'open' },
      _sum: { units: true },
    }),
  ])
  const stockOf = new Map(stock.map((row) => [row.warehouseId, row._sum.units ?? 0]))
  const reservedOf = new Map(reserved.map((row) => [row.warehouseId, row._sum.units ?? 0]))
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    priority: row.priority,
    active: row.active,
    isDefault: row.code === DEFAULT_WAREHOUSE_CODE,
    stock: stockOf.get(row.id) ?? 0,
    reserved: reservedOf.get(row.id) ?? 0,
    channels: row.channelWarehouses.map((choice) => choice.connection),
  }))
}

export async function getWarehouse(ctx: Context, organizationId: string, warehouseId: string): Promise<WarehouseRow | null> {
  const all = await listWarehouses(ctx, organizationId)
  return all.find((warehouse) => warehouse.id === warehouseId) ?? null
}

/** A new active Warehouse; without a priority it goes last. It holds nothing, so no Channel's number changes. */
export async function createWarehouse(
  ctx: Context,
  organizationId: string,
  input: { name: string; priority?: number },
  actor: Actor,
): Promise<{ warehouseId: string }> {
  await ensureDefaultWarehouse(ctx.db, organizationId)
  return ctx.db.$transaction(async (tx) => {
    const last = await tx.warehouse.aggregate({ where: { organizationId }, _max: { priority: true } })
    const parsed = warehouseInputSchema.safeParse({
      name: input.name,
      priority: input.priority ?? Math.min(1_000_000, (last._max.priority ?? 0) + 1),
    })
    if (!parsed.success) throw new RangeError('Name must be 1–100 characters and priority a whole number from 0 to 1,000,000')
    // Only the default Warehouse has a meaningful code; any other uses its own id, which keeps codes unique.
    const id = randomUUID()
    await tx.warehouse.create({ data: { id, organizationId, code: id, ...parsed.data } })
    await appendEvent(tx, {
      organizationId,
      type: 'warehouse.created',
      subject: { type: 'warehouse', id },
      payload: { name: parsed.data.name, priority: parsed.data.priority, actor },
    })
    return { warehouseId: id }
  }, TX_OPTIONS)
}

/** Renames or reorders. Priority only affects Reservations made from now on, so nothing is pushed. */
export async function updateWarehouse(
  ctx: Context,
  organizationId: string,
  warehouseId: string,
  input: WarehouseInput,
  actor: Actor,
): Promise<void> {
  const parsed = warehouseInputSchema.safeParse(input)
  if (!parsed.success) throw new RangeError('Name must be 1–100 characters and priority a whole number from 0 to 1,000,000')
  const to = parsed.data
  await ctx.db.$transaction(async (tx) => {
    const from = await lockWarehouse(tx, organizationId, warehouseId)
    if (from.name === to.name && from.priority === to.priority) return
    await tx.warehouse.updateMany({ where: { id: warehouseId, organizationId }, data: to })
    await appendEvent(tx, {
      organizationId,
      type: 'warehouse.updated',
      subject: { type: 'warehouse', id: warehouseId },
      payload: { from: { name: from.name, priority: from.priority }, to, actor },
    })
  }, TX_OPTIONS)
}

/**
 * Deactivating is refused for the default Warehouse, while it holds Stock or open Reservations, or
 * while a Channel chose it explicitly; so an inactive Warehouse contributes 0 to every Available and
 * neither direction needs a push (ADR 0017).
 */
export async function setWarehouseActive(
  ctx: Context,
  organizationId: string,
  warehouseId: string,
  active: boolean,
  actor: Actor,
): Promise<void> {
  await ctx.db.$transaction(async (tx) => {
    const warehouse = await lockWarehouse(tx, organizationId, warehouseId)
    if (warehouse.active === active) return
    if (!active) await assertCanRetire(tx, organizationId, warehouse, { forDelete: false })
    await tx.warehouse.updateMany({ where: { id: warehouseId, organizationId }, data: { active } })
    await appendEvent(tx, {
      organizationId,
      type: active ? 'warehouse.activated' : 'warehouse.deactivated',
      subject: { type: 'warehouse', id: warehouseId },
      payload: { actor },
    })
  }, TX_OPTIONS)
}

/** Deleting is refused as deactivating is, and also once any Reservation (even a closed one) was made in it. */
export async function deleteWarehouse(ctx: Context, organizationId: string, warehouseId: string, actor: Actor): Promise<void> {
  await ctx.db.$transaction(async (tx) => {
    const warehouse = await lockWarehouse(tx, organizationId, warehouseId, 'delete')
    await assertCanRetire(tx, organizationId, warehouse, { forDelete: true })
    // Cascades to its Stock rows, all of them 0 by the check above.
    await tx.warehouse.deleteMany({ where: { id: warehouseId, organizationId } })
    await appendEvent(tx, {
      organizationId,
      type: 'warehouse.deleted',
      subject: { type: 'warehouse', id: warehouseId },
      payload: { name: warehouse.name, actor },
    })
  }, TX_OPTIONS)
}

interface LockedRow {
  id: string
  code: string
  name: string
  priority: number
  active: boolean
}

/**
 * The one Warehouse row, and no other lock afterwards (ADR 0017): every writer that could put Stock,
 * a Reservation or a Channel's choice into it holds it FOR SHARE first, and both modes conflict with
 * that, so the checks read after this lock are exact. An edit takes NO KEY UPDATE, which leaves
 * foreign-key checks (KEY SHARE) alone; a delete needs FOR UPDATE.
 */
async function lockWarehouse(tx: Tx, organizationId: string, warehouseId: string, mode: 'edit' | 'delete' = 'edit'): Promise<LockedRow> {
  const rows =
    mode === 'delete'
      ? await tx.$queryRaw<LockedRow[]>`
          SELECT "id", "code", "name", "priority", "active" FROM "warehouse"
          WHERE "id" = ${warehouseId} AND "organizationId" = ${organizationId}
          FOR UPDATE`
      : await tx.$queryRaw<LockedRow[]>`
          SELECT "id", "code", "name", "priority", "active" FROM "warehouse"
          WHERE "id" = ${warehouseId} AND "organizationId" = ${organizationId}
          FOR NO KEY UPDATE`
  const row = rows[0]
  if (!row) throw new DomainError('not_found')
  return row
}

async function assertCanRetire(tx: Tx, organizationId: string, warehouse: LockedRow, options: { forDelete: boolean }): Promise<void> {
  if (warehouse.code === DEFAULT_WAREHOUSE_CODE) throw new DomainError('warehouse_is_default')
  const where = { organizationId, warehouseId: warehouse.id }
  const stock = await tx.stock.count({ where: { ...where, units: { not: 0 } } })
  const open = await tx.reservation.count({ where: { ...where, status: 'open' } })
  if (stock > 0 || open > 0) throw new DomainError('warehouse_not_empty')
  if ((await tx.connectionWarehouse.count({ where })) > 0) throw new DomainError('warehouse_in_use')
  if (options.forDelete && (await tx.reservation.count({ where })) > 0) throw new DomainError('warehouse_in_use')
}
