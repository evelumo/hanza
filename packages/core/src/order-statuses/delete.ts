import type { Prisma } from '@hanza/db'
import type { Actor } from '../actor'
import { afterCommit } from '../after-commit'
import type { Context } from '../context'
import { DomainError } from '../errors'
import { appendEvent } from '../events'
import { PermanentJobError } from '../jobs'
import { coalesceKeys, orderStatusesDeleteRef } from '../jobs/refs'
import type { OrderPhase } from '../orders/phases'
import { TX_OPTIONS } from '../transaction'
import { ensureDefaultOrderStatuses, findStatus, isPendingReplacement, snapshotOf, type StatusSnapshot } from './defaults'
import { moveMappings } from './mapping'
import { assertCanManageOrderStatuses } from './permissions'
import { lockStatuses } from './statuses'

/** Orders moved per transaction: each batch holds its row locks only briefly. */
export const DELETE_BATCH_SIZE = 500
/** How long `sync.tick` leaves a deletion to its job before enqueuing it again (a lost enqueue, a failed job). */
export const DELETION_RETRY_MS = 600_000
/** Most deletions one tick enqueues; the rest come up on the following ticks. */
export const DELETION_SWEEP_LIMIT = 100
/** How often one run retries when Orders still reference the status at the end (moved to it by a racing transaction). */
const DELETE_ROUNDS = 5

/**
 * Deletes a status that is not a phase default. A status still used by Orders or Status mappings needs a replacement:
 * an active status of the same phase. In one transaction the status is deactivated, marked as being deleted (with its
 * replacement) and its mappings move to the replacement, so nothing new picks it. An unused status is then deleted
 * right away (`deleted: true`); otherwise the `orderStatuses.delete` job moves its Orders in the worker. A lost enqueue
 * (ADR 0010) is recovered by `sync.tick`, which enqueues every deletion still marked after `DELETION_RETRY_MS`.
 * Deleting a status already being deleted enqueues its job again.
 */
export async function deleteOrderStatus(
  ctx: Context,
  organizationId: string,
  statusId: string,
  replacementId: string | null,
  actor: Actor,
): Promise<{ deleted: boolean }> {
  await assertCanManageOrderStatuses(ctx, organizationId, actor)
  const started = await ctx.db.$transaction(async (tx) => {
    await lockStatuses(tx, organizationId, replacementId ? [statusId, replacementId] : [statusId])
    const status = await findStatus(tx, organizationId, statusId)
    if (status.isDefault) throw new DomainError('status_is_default')
    if (status.replacedById !== null) return { resume: true as const, status }
    if (await isPendingReplacement(tx, organizationId, statusId)) throw new DomainError('status_is_replacement')
    const inUse =
      (await tx.order.count({ where: { organizationId, statusId } })) + (await tx.channelStatusMapping.count({ where: { organizationId, statusId } })) > 0
    if (!replacementId) {
      if (inUse) throw new DomainError('status_in_use')
      return { resume: false as const, status, replacement: null }
    }
    const replacement = await tx.orderStatus.findFirst({
      where: { id: replacementId, organizationId },
      select: { id: true, name: true, phase: true, active: true },
    })
    if (!replacement || replacement.id === status.id || replacement.phase !== status.phase || !replacement.active) {
      throw new DomainError('invalid_replacement')
    }
    await tx.$executeRaw`
      UPDATE "order_status"
      SET "active" = false, "replacedById" = ${replacement.id},
        "deletionDueAt" = now() + ${DELETION_RETRY_MS}::integer * interval '1 millisecond', "updatedAt" = now()
      WHERE "id" = ${statusId} AND "organizationId" = ${organizationId}`
    const from = snapshotOf(status)
    const to = snapshotOf(replacement)
    await appendEvent(tx, {
      organizationId,
      type: 'order_status.deletion_requested',
      subject: { type: 'order_status', id: statusId },
      payload: { phase: status.phase, name: status.name, wasActive: status.active, replacement: to, actor },
    })
    await moveMappings(tx, organizationId, from, to, actor)
    return { resume: false as const, status, replacement }
  }, TX_OPTIONS)

  const from = snapshotOf(started.status)
  if (!started.resume) {
    const to = started.replacement ? snapshotOf(started.replacement) : null
    if (await deleteIfUnused(ctx, organizationId, started.status.phase, from, to, 0, actor)) return { deleted: true }
    if (!to) throw new DomainError('status_in_use')
  }
  await enqueueDeletion(ctx, organizationId, statusId, actor)
  return { deleted: false }
}

/** Best effort (ADR 0010): the status stays marked, and `sync.tick` enqueues it again if this is lost. */
export async function enqueueDeletion(ctx: Context, organizationId: string, statusId: string, actor: Actor): Promise<void> {
  await afterCommit(ctx, { job: orderStatusesDeleteRef.name, organizationId, statusId }, () =>
    ctx.queue.enqueue(orderStatusesDeleteRef, { organizationId, statusId, actor }, { coalesceKey: coalesceKeys.orderStatusesDelete(statusId) }),
  )
}

/**
 * The worker's part. Each round it takes the replacement recorded on the status (or, should that one be gone or
 * inactive, the phase default), moves any Status mapping still on the status and its Orders in batches, each its own
 * transaction, and then deletes it. Idempotent: a status already gone is done. Throws while something still references
 * it, so the job retries; `PermanentJobError` when the status is not being deleted (nothing to do).
 */
export async function finishOrderStatusDeletion(
  ctx: Context,
  organizationId: string,
  statusId: string,
  actor: Actor,
  options: { batchSize?: number } = {},
): Promise<{ moved: number }> {
  let moved = 0
  for (let round = 0; round < DELETE_ROUNDS; round++) {
    const target = await deletionTarget(ctx, organizationId, statusId, actor)
    if (!target) return { moved }
    const { from, to } = target
    let batch: number
    do {
      batch = await moveOrdersBatch(ctx, organizationId, from, to, actor, options.batchSize ?? DELETE_BATCH_SIZE)
      moved += batch
    } while (batch > 0)
    if (await deleteIfUnused(ctx, organizationId, from.phase, from, to, moved, actor)) return { moved }
    await new Promise((resolve) => setTimeout(resolve, 50 * (round + 1)))
  }
  throw new Error(`Order status ${statusId} is still referenced after ${DELETE_ROUNDS} rounds`)
}

/**
 * Where the status's Orders go now, and its mappings moved there; null when the status is gone. A replacement that
 * was deleted or deactivated meanwhile (the services refuse both, so only by hand) gives way to the phase default.
 */
async function deletionTarget(
  ctx: Context,
  organizationId: string,
  statusId: string,
  actor: Actor,
): Promise<{ from: StatusSnapshot; to: StatusSnapshot } | null> {
  const found = await ctx.db.orderStatus.findFirst({ where: { id: statusId, organizationId }, select: { phase: true } })
  if (!found) return null
  await ensureDefaultOrderStatuses(ctx.db, organizationId)
  return ctx.db.$transaction(async (tx) => {
    const defaultId = (await tx.orderStatus.findFirst({ where: { organizationId, phase: found.phase, isDefault: true }, select: { id: true } }))?.id
    const current = await tx.orderStatus.findFirst({ where: { id: statusId, organizationId }, select: { replacedById: true } })
    await lockStatuses(tx, organizationId, [statusId, current?.replacedById, defaultId].filter((id): id is string => Boolean(id)))
    const status = await tx.orderStatus.findFirst({
      where: { id: statusId, organizationId },
      select: { id: true, name: true, phase: true, replacedById: true },
    })
    if (!status) return null
    if (status.replacedById === null) throw new PermanentJobError(`Order status ${statusId} is not being deleted`)
    let replacement = await tx.orderStatus.findFirst({
      where: { id: status.replacedById, organizationId, phase: status.phase, active: true },
      select: { id: true, name: true, phase: true },
    })
    if (!replacement) {
      replacement = await tx.orderStatus.findFirst({ where: { organizationId, phase: status.phase, isDefault: true }, select: { id: true, name: true, phase: true } })
      if (!replacement) throw new PermanentJobError(`No status to move the Orders of ${statusId} to`)
      await tx.orderStatus.updateMany({ where: { id: statusId, organizationId }, data: { replacedById: replacement.id } })
    }
    const from = snapshotOf(status)
    const to = snapshotOf(replacement)
    await moveMappings(tx, organizationId, from, to, actor)
    return { from, to }
  }, TX_OPTIONS)
}

/**
 * Moves up to `size` Orders of the status to the replacement, each with an Event. SKIP LOCKED: an Order being imported
 * or changed right now is left to the next batch instead of making this one wait.
 */
async function moveOrdersBatch(ctx: Context, organizationId: string, from: StatusSnapshot, to: StatusSnapshot, actor: Actor, size: number): Promise<number> {
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
    const payload = { from: from.phase, to: to.phase, fromStatus: from, toStatus: to, cause: 'status_deleted', factId: null, actor }
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
    const replacing = await tx.orderStatus.count({ where: { organizationId, replacedById: from.id } })
    if (orders + mappings + replacing > 0) return false
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

/**
 * Claims the deletions whose job is overdue by moving their due time one retry interval ahead, so each is enqueued at
 * most once per interval whatever happens to its job. Rows locked right now are skipped.
 */
export async function claimDueDeletions(ctx: Context, limit: number): Promise<Array<{ organizationId: string; id: string }>> {
  return ctx.db.$queryRaw<Array<{ organizationId: string; id: string }>>`
    UPDATE "order_status"
    SET "deletionDueAt" = now() + ${DELETION_RETRY_MS}::integer * interval '1 millisecond'
    WHERE "id" IN (
      SELECT "id" FROM "order_status"
      WHERE "deletionDueAt" <= now()
      ORDER BY "deletionDueAt", "id"
      LIMIT ${limit}
      FOR NO KEY UPDATE SKIP LOCKED)
    RETURNING "organizationId", "id"`
}
