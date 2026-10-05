import type { OrderStatusColor, Tx } from '@hanza/db'
import { z } from 'zod'
import type { Actor } from '../actor'
import type { Context } from '../context'
import { DomainError, isUniqueViolation } from '../errors'
import { appendEvent } from '../events'
import { ORDER_PHASES, type OrderPhase } from '../orders/phases'
import { TX_OPTIONS } from '../transaction'
import { ensureDefaultOrderStatuses, findStatus, isPendingReplacement, snapshotOf } from './defaults'
import { assertCanManageOrderStatuses } from './permissions'

export const ORDER_STATUS_COLORS = ['gray', 'blue', 'teal', 'green', 'amber', 'orange', 'red', 'violet'] as const satisfies readonly OrderStatusColor[]
export const ORDER_STATUS_NAME_MAX = 60
const nameSchema = z.string().trim().min(1).max(ORDER_STATUS_NAME_MAX)

export interface OrderStatusRow {
  id: string
  phase: OrderPhase
  /** Null = the phase's own name, translated when shown. */
  name: string | null
  color: OrderStatusColor | null
  position: number
  active: boolean
  isDefault: boolean
  /** Set while the status is being deleted: the status its Orders move to. */
  replacedById: string | null
  orderCount: number
  mappingCount: number
}

/** Every status of the organization, phase by phase in phase order, then by position. */
export async function listOrderStatuses(ctx: Context, organizationId: string): Promise<OrderStatusRow[]> {
  await ensureDefaultOrderStatuses(ctx.db, organizationId)
  const [statuses, orders, mappings] = await Promise.all([
    ctx.db.orderStatus.findMany({
      where: { organizationId },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, phase: true, name: true, color: true, position: true, active: true, isDefault: true, replacedById: true },
    }),
    ctx.db.order.groupBy({ by: ['statusId'], where: { organizationId }, _count: { _all: true } }),
    ctx.db.channelStatusMapping.groupBy({ by: ['statusId'], where: { organizationId }, _count: { _all: true } }),
  ])
  const orderCount = new Map(orders.map((row) => [row.statusId, row._count._all]))
  const mappingCount = new Map(mappings.map((row) => [row.statusId, row._count._all]))
  return statuses
    .map((status) => ({ ...status, orderCount: orderCount.get(status.id) ?? 0, mappingCount: mappingCount.get(status.id) ?? 0 }))
    .sort((a, b) => ORDER_PHASES.indexOf(a.phase) - ORDER_PHASES.indexOf(b.phase))
}

/**
 * The statuses to offer in a filter or a select: no counts, and nothing created (an organization without statuses has
 * no Orders either). Phase by phase, then by position.
 */
export async function listOrderStatusOptions(
  ctx: Context,
  organizationId: string,
): Promise<Array<{ id: string; name: string | null; phase: OrderPhase; color: OrderStatusColor | null; active: boolean }>> {
  const rows = await ctx.db.orderStatus.findMany({
    where: { organizationId },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true, phase: true, color: true, active: true },
  })
  return rows.sort((a, b) => ORDER_PHASES.indexOf(a.phase) - ORDER_PHASES.indexOf(b.phase))
}

/** Locks the phase's statuses in id order, so reorders and default changes of one phase run one at a time. */
async function lockPhase(tx: Tx, organizationId: string, phase: OrderPhase): Promise<void> {
  await tx.$queryRaw`
    SELECT "id" FROM "order_status"
    WHERE "organizationId" = ${organizationId} AND "phase" = ${phase}::"order_phase"
    ORDER BY "id"
    FOR NO KEY UPDATE`
}

/** Case-insensitive, among active statuses (the database index only catches exact duplicates). */
async function assertNameFree(tx: Tx, organizationId: string, name: string, exceptId: string | null): Promise<void> {
  const taken = await tx.orderStatus.findFirst({
    where: { organizationId, active: true, name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  })
  if (taken) throw new DomainError('status_name_taken')
}

async function withNameTaken<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (isUniqueViolation(error)) throw new DomainError('status_name_taken')
    throw error
  }
}

export async function createOrderStatus(
  ctx: Context,
  organizationId: string,
  input: { phase: OrderPhase; name: string; color: OrderStatusColor | null },
  actor: Actor,
): Promise<{ statusId: string }> {
  await assertCanManageOrderStatuses(ctx, organizationId, actor)
  const name = nameSchema.parse(input.name)
  await ensureDefaultOrderStatuses(ctx.db, organizationId)
  return withNameTaken(() =>
    ctx.db.$transaction(async (tx) => {
      await lockPhase(tx, organizationId, input.phase)
      await assertNameFree(tx, organizationId, name, null)
      const last = await tx.orderStatus.aggregate({ where: { organizationId, phase: input.phase }, _max: { position: true } })
      const status = await tx.orderStatus.create({
        data: { organizationId, phase: input.phase, name, color: input.color, position: (last._max.position ?? -1) + 1 },
        select: { id: true },
      })
      await appendEvent(tx, {
        organizationId,
        type: 'order_status.created',
        subject: { type: 'order_status', id: status.id },
        payload: { phase: input.phase, name, color: input.color, actor },
      })
      return { statusId: status.id }
    }, TX_OPTIONS),
  )
}

/**
 * Rename and recolour. Orders keep the status; past Events keep the old name. An empty name (the phase's own name) is
 * only for a phase default, and for a former default that never got a name.
 */
export async function updateOrderStatus(
  ctx: Context,
  organizationId: string,
  statusId: string,
  input: { name: string | null; color: OrderStatusColor | null },
  actor: Actor,
): Promise<void> {
  await assertCanManageOrderStatuses(ctx, organizationId, actor)
  const name = input.name === null || input.name.trim() === '' ? null : nameSchema.parse(input.name)
  await withNameTaken(() =>
    ctx.db.$transaction(async (tx) => {
      await lockStatuses(tx, organizationId, [statusId])
      const status = await findStatus(tx, organizationId, statusId)
      if (name === null && status.name !== null && !status.isDefault) throw new DomainError('status_name_required')
      if (name !== null && status.active) await assertNameFree(tx, organizationId, name, statusId)
      const changes: Record<string, { from: unknown; to: unknown }> = {}
      if (status.name !== name) changes.name = { from: status.name, to: name }
      if (status.color !== input.color) changes.color = { from: status.color, to: input.color }
      if (Object.keys(changes).length === 0) return
      await tx.orderStatus.updateMany({ where: { id: statusId, organizationId }, data: { name, color: input.color } })
      await appendEvent(tx, {
        organizationId,
        type: 'order_status.updated',
        subject: { type: 'order_status', id: statusId },
        payload: { ...changes, actor },
      })
    }, TX_OPTIONS),
  )
}

/** Swaps the status with its neighbour within the phase and renumbers the phase from 0. */
export async function moveOrderStatus(ctx: Context, organizationId: string, statusId: string, direction: 'up' | 'down', actor: Actor): Promise<void> {
  await assertCanManageOrderStatuses(ctx, organizationId, actor)
  await ctx.db.$transaction(async (tx) => {
    const { phase } = await findStatus(tx, organizationId, statusId)
    await lockPhase(tx, organizationId, phase)
    const ordered = await tx.orderStatus.findMany({
      where: { organizationId, phase },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, position: true },
    })
    const index = ordered.findIndex((status) => status.id === statusId)
    const neighbour = direction === 'up' ? index - 1 : index + 1
    if (index === -1 || neighbour < 0 || neighbour >= ordered.length) return
    const ids = ordered.map((status) => status.id)
    ;[ids[index], ids[neighbour]] = [ids[neighbour]!, ids[index]!]
    for (const [position, id] of ids.entries()) {
      if (ordered.find((status) => status.id === id)?.position === position) continue
      await tx.orderStatus.updateMany({ where: { id, organizationId }, data: { position } })
    }
    await appendEvent(tx, {
      organizationId,
      type: 'order_status.updated',
      subject: { type: 'order_status', id: statusId },
      payload: { moved: direction, actor },
    })
  }, TX_OPTIONS)
}

/**
 * An inactive status keeps its Orders but cannot be chosen. The default stays active, a status being deleted cannot be
 * activated again, and a status a deletion moves Orders to cannot be deactivated.
 */
export async function setOrderStatusActive(ctx: Context, organizationId: string, statusId: string, active: boolean, actor: Actor): Promise<void> {
  await assertCanManageOrderStatuses(ctx, organizationId, actor)
  await withNameTaken(() =>
    ctx.db.$transaction(async (tx) => {
      await lockStatuses(tx, organizationId, [statusId])
      const status = await findStatus(tx, organizationId, statusId)
      if (status.active === active) return
      if (!active && status.isDefault) throw new DomainError('status_is_default')
      if (active && status.replacedById !== null) throw new DomainError('status_pending_deletion')
      if (!active && (await isPendingReplacement(tx, organizationId, statusId))) throw new DomainError('status_is_replacement')
      if (active && status.name !== null) await assertNameFree(tx, organizationId, status.name, statusId)
      await tx.orderStatus.updateMany({ where: { id: statusId, organizationId }, data: { active } })
      await appendEvent(tx, {
        organizationId,
        type: 'order_status.updated',
        subject: { type: 'order_status', id: statusId },
        payload: { active: { from: status.active, to: active }, actor },
      })
    }, TX_OPTIONS),
  )
}

/** The status Orders get when they enter its phase without a Status mapping. Orders already in the phase keep theirs. */
export async function makeDefaultOrderStatus(ctx: Context, organizationId: string, statusId: string, actor: Actor): Promise<void> {
  await assertCanManageOrderStatuses(ctx, organizationId, actor)
  await ensureDefaultOrderStatuses(ctx.db, organizationId)
  await ctx.db.$transaction(async (tx) => {
    const { phase } = await findStatus(tx, organizationId, statusId)
    await lockPhase(tx, organizationId, phase)
    const status = await findStatus(tx, organizationId, statusId)
    if (status.isDefault) return
    if (!status.active) throw new DomainError('status_inactive')
    const current = await tx.orderStatus.findFirst({ where: { organizationId, phase, isDefault: true }, select: { id: true, name: true, phase: true } })
    const previous = current ? snapshotOf(current) : null
    // Unset first: the partial unique index allows one default per phase at any moment.
    await tx.orderStatus.updateMany({ where: { organizationId, phase, isDefault: true }, data: { isDefault: false } })
    await tx.orderStatus.updateMany({ where: { id: statusId, organizationId }, data: { isDefault: true } })
    await appendEvent(tx, {
      organizationId,
      type: 'order_status.updated',
      subject: { type: 'order_status', id: statusId },
      payload: { isDefault: { from: false, to: true }, previousDefault: previous, actor },
    })
  }, TX_OPTIONS)
}

/** Locks the statuses in id order: the one order every writer of several statuses uses. */
export async function lockStatuses(tx: Tx, organizationId: string, statusIds: string[]): Promise<void> {
  const ids = [...new Set(statusIds)].sort()
  await tx.$queryRaw`
    SELECT "id" FROM "order_status"
    WHERE "organizationId" = ${organizationId} AND "id" = ANY(${ids}::text[])
    ORDER BY "id"
    FOR NO KEY UPDATE`
}
