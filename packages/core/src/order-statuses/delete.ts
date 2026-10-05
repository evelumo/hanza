import type { Prisma } from '@hanza/db'
import type { Actor } from '../actor'
import { afterCommit } from '../after-commit'
import type { Context } from '../context'
import { DomainError } from '../errors'
import { appendEvent } from '../events'
import { coalesceKeys, orderStatusesDeleteRef } from '../jobs/refs'
import type { OrderPhase } from '../orders/phases'
import { TX_OPTIONS } from '../transaction'
import { findStatus, type StatusSnapshot } from './defaults'
import { assertCanManageOrderStatuses } from './permissions'
import { lockStatuses } from './statuses'

/** Orders moved per transaction: each batch holds its row locks only briefly. */
export const DELETE_BATCH_SIZE = 500
/** How often one run retries when Orders still reference the status at the end (moved to it by a racing transaction). */
const DELETE_ROUNDS = 5

/**
 * Deletes a status that is not a phase default. A status still used by Orders or Status mappings needs a replacement:
 * an active status of the same phase. The status is deactivated and its mappings move to the replacement at once, so
 * nothing new picks it; an unused status is deleted right away (`deleted: true`). Otherwise its Orders are moved by
 * the `orderStatuses.delete` job, in the worker. If that enqueue is lost (ADR 0010), the status stays inactive with
 * its Orders, and deleting it again resumes the move.
 */
export async function deleteOrderStatus(
  ctx: Context,
  organizationId: string,
  statusId: string,
  replacementId: string | null,
  actor: Actor,
): Promise<{ deleted: boolean }> {
  await assertCanManageOrderStatuses(ctx, organizationId, actor)
  const { status, replacement, inUse } = await ctx.db.$transaction(async (tx) => {
    await lockStatuses(tx, organizationId, replacementId ? [statusId, replacementId] : [statusId])
    const status = await findStatus(tx, organizationId, statusId)
    if (status.isDefault) throw new DomainError('status_is_default')
    const inUse = (await tx.order.count({ where: { organizationId, statusId } })) + (await tx.channelStatusMapping.count({ where: { organizationId, statusId } })) > 0
    if (!replacementId) {
      if (inUse) throw new DomainError('status_in_use')
      return { status, replacement: null, inUse }
    }
    const replacement = await tx.orderStatus.findFirst({
      where: { id: replacementId, organizationId },
      select: { id: true, name: true, phase: true, active: true },
    })
    if (!replacement || replacement.id === status.id || replacement.phase !== status.phase || !replacement.active) {
      throw new DomainError('invalid_replacement')
    }
    if (status.active) await tx.orderStatus.updateMany({ where: { id: statusId, organizationId }, data: { active: false } })
    await tx.channelStatusMapping.updateMany({ where: { organizationId, statusId }, data: { statusId: replacement.id } })
    return { status, replacement, inUse }
  }, TX_OPTIONS)

  const from: StatusSnapshot = { id: status.id, name: status.name }
  const to: StatusSnapshot | null = replacement ? { id: replacement.id, name: replacement.name } : null
  if (await deleteIfUnused(ctx, organizationId, status.phase, from, to, 0, actor)) return { deleted: true }
  if (!replacement || !inUse) throw new DomainError('status_in_use')

  const payload = { organizationId, statusId, replacementId: replacement.id, actor }
  await afterCommit(ctx, { job: orderStatusesDeleteRef.name, organizationId, statusId }, () =>
    ctx.queue.enqueue(orderStatusesDeleteRef, payload, { coalesceKey: coalesceKeys.orderStatusesDelete(statusId) }),
  )
  return { deleted: false }
}

/**
 * The worker's part: moves the status's Orders to the replacement in batches, each its own transaction, then deletes
 * the status. Idempotent: a status already gone is done. Throws while something still references it, so the job retries.
 */
export async function finishOrderStatusDeletion(
  ctx: Context,
  organizationId: string,
  statusId: string,
  replacementId: string,
  actor: Actor,
  options: { batchSize?: number } = {},
): Promise<{ moved: number }> {
  const status = await ctx.db.orderStatus.findFirst({ where: { id: statusId, organizationId }, select: { id: true, name: true, phase: true } })
  if (!status) return { moved: 0 }
  const replacement = await ctx.db.orderStatus.findFirst({
    where: { id: replacementId, organizationId, phase: status.phase },
    select: { id: true, name: true },
  })
  if (!replacement) throw new DomainError('invalid_replacement')
  const from: StatusSnapshot = { id: status.id, name: status.name }
  const to: StatusSnapshot = { id: replacement.id, name: replacement.name }

  let moved = 0
  for (let round = 0; round < DELETE_ROUNDS; round++) {
    let batch: number
    do {
      batch = await moveOrdersBatch(ctx, organizationId, status.phase, from, to, actor, options.batchSize ?? DELETE_BATCH_SIZE)
      moved += batch
    } while (batch > 0)
    if (await deleteIfUnused(ctx, organizationId, status.phase, from, to, moved, actor)) return { moved }
    await new Promise((resolve) => setTimeout(resolve, 50 * (round + 1)))
  }
  throw new DomainError('status_in_use', `Order status ${statusId} is still referenced after ${DELETE_ROUNDS} rounds`)
}

/**
 * Moves up to `size` Orders of the status to the replacement, each with an Event. SKIP LOCKED: an Order being imported
 * or changed right now is left to the next batch instead of making this one wait.
 */
async function moveOrdersBatch(
  ctx: Context,
  organizationId: string,
  phase: OrderPhase,
  from: StatusSnapshot,
  to: StatusSnapshot,
  actor: Actor,
  size: number,
): Promise<number> {
  return ctx.db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE "order" SET "statusId" = ${to.id}, "updatedAt" = now()
      WHERE "id" IN (
        SELECT "id" FROM "order"
        WHERE "organizationId" = ${organizationId} AND "statusId" = ${from.id}
        ORDER BY "id"
        LIMIT ${size}
        FOR NO KEY UPDATE SKIP LOCKED)
      RETURNING "id"`
    if (rows.length === 0) return 0
    const payload = { from: phase, to: phase, fromStatus: from, toStatus: to, cause: 'status_deleted', factId: null, actor }
    await tx.eventLog.createMany({
      data: rows.map((row) => ({
        organizationId,
        type: 'order.status_changed',
        subjectType: 'order',
        subjectId: row.id,
        payload: payload as Prisma.InputJsonObject,
      })),
    })
    return rows.length
  }, TX_OPTIONS)
}

/**
 * FOR UPDATE waits for every transaction that already references the status (they hold FOR KEY SHARE on it), so the
 * count after it sees their Orders. Returns false when some are left to move.
 */
async function deleteIfUnused(
  ctx: Context,
  organizationId: string,
  phase: OrderPhase,
  from: StatusSnapshot,
  to: StatusSnapshot | null,
  moved: number,
  actor: Actor,
): Promise<boolean> {
  return ctx.db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ isDefault: boolean }>>`
      SELECT "isDefault" FROM "order_status" WHERE "id" = ${from.id} AND "organizationId" = ${organizationId} FOR UPDATE`
    if (!locked[0]) return true
    // Made the default since it was checked (only possible while it was still active).
    if (locked[0].isDefault) throw new DomainError('status_is_default')
    const orders = await tx.order.count({ where: { organizationId, statusId: from.id } })
    const mappings = await tx.channelStatusMapping.count({ where: { organizationId, statusId: from.id } })
    if (orders + mappings > 0) return false
    await tx.orderStatus.deleteMany({ where: { id: from.id, organizationId, isDefault: false } })
    await appendEvent(tx, {
      organizationId,
      type: 'order_status.deleted',
      subject: { type: 'order_status', id: from.id },
      payload: { phase, name: from.name, replacement: to, moved, actor },
    })
    return true
  }, TX_OPTIONS)
}
