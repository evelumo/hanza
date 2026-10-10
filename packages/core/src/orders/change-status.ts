import type { Tx } from '@hanza/db'
import type { Actor } from '../actor'
import { systemActor } from '../actor'
import { afterCommit } from '../after-commit'
import type { Context } from '../context'
import { DomainError } from '../errors'
import { appendEvent } from '../events'
import { coalesceKeys, ordersUpdateStatusRef } from '../jobs/refs'
import { defaultStatus, ensureDefaultOrderStatuses, lockedStatus, snapshotOf } from '../order-statuses/defaults'
import { lockOrder } from '../stock/locks'
import { markOffersForStockPush, requestStockPushAfterCommit } from '../stock/push'
import { ensureDefaultWarehouse } from '../stock/warehouse'
import { TX_OPTIONS } from '../transaction'
import type { OrderPhase } from './phases'
import { reasonsAfterCancel } from './reasons'
import { canMoveToStatus, isFinalPhase } from './status-rules'
import { markStatusPushPending } from './status-push'
import { applyStockEffect } from './stock-effect'

/** Where a person moves an Order: one of the organization's Order statuses, or a phase, meaning that phase's default status. */
export type StatusTarget = OrderPhase | { statusId: string }

/** Who moves the Order: a person, or a Carrier taking one of its Shipments (ADR 0024). */
export type StatusMoveCause = { cause: 'user'; actor: Actor } | { cause: 'shipment'; shipmentId: string }

/** What a move left to do once its transaction has committed (`requestPushesAfterStatusMove`). */
export interface StatusMove {
  /** Channels whose Offers got a new Available. */
  stockPushConnectionIds: string[]
  /** The phase changed and the Order's connector can be told. */
  pushable: boolean
}

export type StatusMoveResult =
  | ({ moved: true } & StatusMove)
  /** Refused before anything was written; `message` is for the `invalid_transition` error. */
  | { moved: false; refusal: 'not_found' | 'awaiting_payment' | 'invalid_transition' | 'unmatched_lines'; message?: string }

/**
 * Moves an Order to another status (`canMoveToStatus`); shipped is refused while an Unmatched line exists, and any
 * phase but cancelled while the Order is awaiting payment. Only a change of phase does anything beyond the label
 * (ADR 0018): cancelling releases the Reservations, shipping consumes them, reaching shipped or cancelled starts the
 * retention clock (`closedAt`), and the push of the new phase to the Channel is marked pending (ADR 0012). A move
 * within the phase pushes nothing and leaves the push marker and `closedAt` alone.
 *
 * The one implementation behind a person's change and a Carrier's pickup. The caller holds the Order lock, taken
 * before any other lock of its transaction (ADR 0004), and has made sure the organization's default Warehouse and
 * Order statuses exist. Every refusal is decided before the first write, so a refused move leaves the transaction
 * as it was and the caller may go on with it.
 */
export async function moveOrderToStatus(
  ctx: Pick<Context, 'connectors'>,
  tx: Tx,
  organizationId: string,
  orderId: string,
  to: StatusTarget,
  cause: StatusMoveCause,
): Promise<StatusMoveResult> {
  const order = await tx.order.findFirst({
    where: { id: orderId, organizationId },
    select: {
      phase: true,
      statusId: true,
      attentionReasons: true,
      awaitingPayment: true,
      status: { select: { id: true, name: true, phase: true } },
      connection: { select: { connectorId: true } },
    },
  })
  if (!order) return { moved: false, refusal: 'not_found' }
  const target = typeof to === 'string' ? await defaultStatus(tx, organizationId, to) : await lockedStatus(tx, organizationId, to.statusId)
  if (!target) return { moved: false, refusal: 'not_found' }
  if (!canMoveToStatus(order, target)) {
    if (canMoveToStatus({ ...order, awaitingPayment: false }, target)) return { moved: false, refusal: 'awaiting_payment' }
    return { moved: false, refusal: 'invalid_transition', message: `Cannot change an Order from ${order.phase} to ${target.phase}` }
  }

  const phaseChanges = target.phase !== order.phase
  let touched: string[] = []
  let pushable = false
  if (phaseChanges) {
    if (target.phase === 'shipped') {
      const unmatched = await tx.orderLine.count({ where: { organizationId, orderId, productId: null } })
      if (unmatched > 0) return { moved: false, refusal: 'unmatched_lines' }
    }
    touched = await applyStockEffect(tx, organizationId, orderId, target.phase)
    const reasons = target.phase === 'cancelled' ? reasonsAfterCancel(order.attentionReasons) : order.attentionReasons
    await tx.order.updateMany({
      where: { id: orderId, organizationId },
      data: {
        phase: target.phase,
        statusId: target.id,
        attentionReasons: reasons,
        ...(isFinalPhase(target.phase) ? { closedAt: new Date() } : {}),
      },
    })
    pushable = ctx.connectors.get(order.connection.connectorId)?.capabilities['orders.updateStatus'] !== undefined
    await markStatusPushPending(tx, organizationId, orderId, pushable)
  } else {
    await tx.order.updateMany({ where: { id: orderId, organizationId }, data: { statusId: target.id } })
  }
  await appendEvent(tx, {
    organizationId,
    type: 'order.status_changed',
    subject: { type: 'order', id: orderId },
    payload: {
      from: order.phase,
      to: target.phase,
      fromStatus: snapshotOf(order.status),
      toStatus: snapshotOf(target),
      cause: cause.cause,
      factId: null,
      ...(cause.cause === 'shipment' ? { shipmentId: cause.shipmentId, actor: systemActor } : { actor: cause.actor }),
    },
  })
  return { moved: true, stockPushConnectionIds: await markOffersForStockPush(tx, organizationId, touched), pushable }
}

/**
 * What follows a committed move: the stock pushes for the Products it touched, and the push of the new phase to the
 * Channel. Both are best-effort (ADR 0010): a failed enqueue is recovered by the sweeps in `sync.tick`, the status push
 * because it stays pending on the Order until it succeeds.
 */
export async function requestPushesAfterStatusMove(ctx: Context, organizationId: string, orderId: string, move: StatusMove): Promise<void> {
  await requestStockPushAfterCommit(ctx, organizationId, move.stockPushConnectionIds)
  if (!move.pushable) return
  await afterCommit(ctx, { job: ordersUpdateStatusRef.name, organizationId, orderId }, () =>
    ctx.queue.enqueue(ordersUpdateStatusRef, { organizationId, orderId }, { coalesceKey: coalesceKeys.ordersUpdateStatus(orderId) }),
  )
}

/**
 * A person moves an Order to another status. See `moveOrderToStatus` for what a move does and refuses; the new phase
 * is then pushed to the Channel, at once if the enqueue works, otherwise by the tick's sweep of pending pushes
 * (ADR 0012).
 */
export async function changeOrderStatus(ctx: Context, organizationId: string, orderId: string, to: StatusTarget, actor: Actor): Promise<void> {
  await ensureDefaultWarehouse(ctx.db, organizationId)
  await ensureDefaultOrderStatuses(ctx.db, organizationId)

  const move = await ctx.db.$transaction(async (tx) => {
    if (!(await lockOrder(tx, organizationId, orderId))) throw new DomainError('not_found')
    const result = await moveOrderToStatus(ctx, tx, organizationId, orderId, to, { cause: 'user', actor })
    if (!result.moved) throw new DomainError(result.refusal, result.message)
    return result
  }, TX_OPTIONS)

  await requestPushesAfterStatusMove(ctx, organizationId, orderId, move)
}
