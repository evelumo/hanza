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

/**
 * The sweep's limit for a failing Connection: one Order probes the Channel each tick instead of a hundred
 * jobs retrying against a Channel that is down. The others stay overdue and are taken once it works again.
 */
export const STATUS_PUSH_SWEEP_LIMIT_FAILING = 1

/**
 * Whether a push still has to tell the Channel. Every status change made since ADR 0011 bumps the seq, so
 * seq 0 can only belong to a job enqueued before the change was deployed: it must still be pushed.
 */
export function isStatusPushPending(order: { statusPushSeq: number; statusPushDueAt: Date | null }): boolean {
  return order.statusPushDueAt !== null || order.statusPushSeq === 0
}

/**
 * In the transaction of a status change a person makes. The seq always counts the change; the push is marked
 * pending only when the Order's connector can update statuses, so nothing waits forever for a push that cannot happen.
 */
export async function markStatusPushPending(tx: Tx, organizationId: string, orderId: string, pushable: boolean): Promise<void> {
  await tx.$executeRaw`
    UPDATE "order"
    SET "statusPushSeq" = "statusPushSeq" + 1,
      "statusPushDueAt" = CASE WHEN ${pushable}::boolean THEN now() + ${STATUS_PUSH_RETRY_MS}::integer * interval '1 millisecond' END
    WHERE "id" = ${orderId} AND "organizationId" = ${organizationId}`
}

/**
 * Claims the Connection's overdue pushes by moving their due time one retry interval ahead, so an Order is
 * enqueued at most once per interval whatever happens to its job. Rows locked by a status change are skipped.
 */
export async function claimDueStatusPushes(ctx: Context, organizationId: string, connectionId: string, limit: number): Promise<string[]> {
  const rows = await ctx.db.$queryRaw<Array<{ id: string }>>`
    UPDATE "order"
    SET "statusPushDueAt" = now() + ${STATUS_PUSH_RETRY_MS}::integer * interval '1 millisecond'
    WHERE "id" IN (
      SELECT "id" FROM "order"
      WHERE "organizationId" = ${organizationId} AND "connectionId" = ${connectionId} AND "statusPushDueAt" <= now()
      ORDER BY "statusPushDueAt", "id"
      LIMIT ${limit}
      FOR NO KEY UPDATE SKIP LOCKED)
    RETURNING "id"`
  return rows.map((row) => row.id).sort()
}

/**
 * Compare-and-clear: a status changed after `seq` was read keeps the push pending. The Channel took this
 * status, so an earlier refusal (`status_push_failed`) no longer needs a person.
 */
export async function markStatusPushed(ctx: Context, organizationId: string, orderId: string, seq: number): Promise<void> {
  await ctx.db.$executeRaw`
    UPDATE "order"
    SET "statusPushDueAt" = NULL,
      "attentionReasons" = array_remove("attentionReasons", 'status_push_failed'::"attention_reason")
    WHERE "id" = ${orderId} AND "organizationId" = ${organizationId} AND "statusPushSeq" = ${seq}
      AND "statusPushDueAt" IS NOT NULL`
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
    if (!order || order.statusPushSeq !== seq || !isStatusPushPending(order)) return
    const { reasons, added } = addReasons(order.attentionReasons, ['status_push_failed'])
    await tx.order.updateMany({ where: { id: orderId, organizationId }, data: { statusPushDueAt: null, attentionReasons: reasons } })
    if (added.length > 0) {
      await appendEvent(tx, { organizationId, type: 'order.attention_raised', subject: { type: 'order', id: orderId }, payload: { reasons: added } })
    }
  }, TX_OPTIONS)
}
