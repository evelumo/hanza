import type { Tx } from '@hanza/db'
import type { Context } from '../context'
import { appendEvent } from '../events'
import { lockOrder } from '../stock/locks'
import { TX_OPTIONS } from '../transaction'
import { addReasons } from './reasons'

// The outbox of Order status pushes (ADR 0011): `statusPushDueAt` is non-null while the Channel has not been
// told the current status. All times come from the database clock, so the web and worker clocks never mix.

/** How long the sweep leaves a pending push alone: the grace for the immediate job, then the retry interval. */
export const STATUS_PUSH_RETRY_MS = 600_000

/** Most Orders one Connection's sweep enqueues per tick; the rest come up on the following ticks. */
export const STATUS_PUSH_SWEEP_LIMIT = 100

/** In the transaction of a status change a person makes: the Channel must be told the new status. */
export async function markStatusPushPending(tx: Tx, organizationId: string, orderId: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE "order"
    SET "statusPushSeq" = "statusPushSeq" + 1,
      "statusPushDueAt" = now() + ${STATUS_PUSH_RETRY_MS}::integer * interval '1 millisecond'
    WHERE "id" = ${orderId} AND "organizationId" = ${organizationId}`
}

/**
 * Claims the Connection's overdue pushes by moving their due time one retry interval ahead, so an Order is
 * enqueued at most once per interval whatever happens to its job. Rows locked by a status change are skipped.
 */
export async function claimDueStatusPushes(ctx: Context, organizationId: string, connectionId: string): Promise<string[]> {
  const rows = await ctx.db.$queryRaw<Array<{ id: string }>>`
    UPDATE "order"
    SET "statusPushDueAt" = now() + ${STATUS_PUSH_RETRY_MS}::integer * interval '1 millisecond'
    WHERE "id" IN (
      SELECT "id" FROM "order"
      WHERE "organizationId" = ${organizationId} AND "connectionId" = ${connectionId} AND "statusPushDueAt" <= now()
      ORDER BY "statusPushDueAt", "id"
      LIMIT ${STATUS_PUSH_SWEEP_LIMIT}
      FOR NO KEY UPDATE SKIP LOCKED)
    RETURNING "id"`
  return rows.map((row) => row.id).sort()
}

/** Compare-and-clear: a status changed after `seq` was read keeps the push pending. */
export async function markStatusPushed(ctx: Context, organizationId: string, orderId: string, seq: number): Promise<void> {
  await ctx.db.order.updateMany({
    where: { id: orderId, organizationId, statusPushSeq: seq, statusPushDueAt: { not: null } },
    data: { statusPushDueAt: null },
  })
}

/**
 * The Channel refused the status read at `seq` for good: stop retrying it and mark the Order Needs attention.
 * A status changed since then keeps its own push.
 */
export async function abandonStatusPush(ctx: Context, organizationId: string, orderId: string, seq: number): Promise<void> {
  await ctx.db.$transaction(async (tx) => {
    if (!(await lockOrder(tx, organizationId, orderId))) return
    const order = await tx.order.findFirst({
      where: { id: orderId, organizationId },
      select: { statusPushSeq: true, statusPushDueAt: true, attentionReasons: true },
    })
    if (!order || order.statusPushSeq !== seq || order.statusPushDueAt === null) return
    const { reasons, added } = addReasons(order.attentionReasons, ['status_push_failed'])
    await tx.order.updateMany({ where: { id: orderId, organizationId }, data: { statusPushDueAt: null, attentionReasons: reasons } })
    if (added.length > 0) {
      await appendEvent(tx, { organizationId, type: 'order.attention_raised', subject: { type: 'order', id: orderId }, payload: { reasons: added } })
    }
  }, TX_OPTIONS)
}
