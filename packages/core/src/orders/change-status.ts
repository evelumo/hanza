import type { OrderStatus } from '@hanza/connector-sdk'
import type { Actor } from '../actor'
import { afterCommit } from '../after-commit'
import type { Context } from '../context'
import { DomainError } from '../errors'
import { appendEvent } from '../events'
import { coalesceKeys, ordersUpdateStatusRef } from '../jobs/refs'
import { lockOrder } from '../stock/locks'
import { markOffersForStockPush, requestStockPushAfterCommit } from '../stock/push'
import { ensureDefaultWarehouse } from '../stock/warehouse'
import { TX_OPTIONS } from '../transaction'
import { reasonsAfterCancel } from './reasons'
import { allowedTransitions } from './status-rules'
import { markStatusPushPending } from './status-push'
import { applyStockEffect } from './stock-effect'

/**
 * A person moves an Order along `allowedTransitions`; shipped is refused while an Unmatched line exists,
 * and anything but cancelled while the Order is awaiting payment.
 * Cancelling releases its Reservations, shipping consumes them, and the new status is then pushed to the Channel:
 * at once if the enqueue works, otherwise by the tick's sweep of pending pushes (ADR 0012).
 */
export async function changeOrderStatus(ctx: Context, organizationId: string, orderId: string, to: OrderStatus, actor: Actor): Promise<void> {
  await ensureDefaultWarehouse(ctx.db, organizationId)

  const { connectionIds, pushable } = await ctx.db.$transaction(async (tx) => {
    if (!(await lockOrder(tx, organizationId, orderId))) throw new DomainError('not_found')
    const order = await tx.order.findFirst({
      where: { id: orderId, organizationId },
      select: { status: true, attentionReasons: true, awaitingPayment: true, connection: { select: { connectorId: true } } },
    })
    if (!order) throw new DomainError('not_found')
    if (!allowedTransitions(order.status, order.awaitingPayment).includes(to)) {
      if (allowedTransitions(order.status).includes(to)) throw new DomainError('awaiting_payment')
      throw new DomainError('invalid_transition', `Cannot change an Order from ${order.status} to ${to}`)
    }
    if (to === 'shipped') {
      const unmatched = await tx.orderLine.count({ where: { organizationId, orderId, productId: null } })
      if (unmatched > 0) throw new DomainError('unmatched_lines')
    }

    const touched = await applyStockEffect(tx, organizationId, orderId, to)
    const reasons = to === 'cancelled' ? reasonsAfterCancel(order.attentionReasons) : order.attentionReasons
    await tx.order.updateMany({ where: { id: orderId, organizationId }, data: { status: to, attentionReasons: reasons } })
    const pushable = ctx.connectors.get(order.connection.connectorId)?.capabilities['orders.updateStatus'] !== undefined
    await markStatusPushPending(tx, organizationId, orderId, pushable)
    await appendEvent(tx, {
      organizationId,
      type: 'order.status_changed',
      subject: { type: 'order', id: orderId },
      payload: { from: order.status, to, cause: 'user', factId: null, actor },
    })
    return { connectionIds: await markOffersForStockPush(tx, organizationId, touched), pushable }
  }, TX_OPTIONS)

  await requestStockPushAfterCommit(ctx, organizationId, connectionIds)
  if (!pushable) return
  // A failed enqueue is recovered by the sweep in `sync.tick`: the push stays pending on the Order until it succeeds.
  await afterCommit(ctx, { job: ordersUpdateStatusRef.name, organizationId, orderId }, () =>
    ctx.queue.enqueue(ordersUpdateStatusRef, { organizationId, orderId }, { coalesceKey: coalesceKeys.ordersUpdateStatus(orderId) }),
  )
}
