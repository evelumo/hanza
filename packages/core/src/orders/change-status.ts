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
import { removeReasons } from './reasons'
import { allowedTransitions } from './status-rules'
import { applyStockEffect } from './stock-effect'

/** A person moves an Order (§2); the new status is then pushed to the Channel. */
export async function changeOrderStatus(ctx: Context, organizationId: string, orderId: string, to: OrderStatus, actor: Actor): Promise<void> {
  await ensureDefaultWarehouse(ctx.db, organizationId)

  const connectionIds = await ctx.db.$transaction(async (tx) => {
    if (!(await lockOrder(tx, organizationId, orderId))) throw new DomainError('not_found')
    const order = await tx.order.findFirst({ where: { id: orderId, organizationId }, select: { status: true, attentionReasons: true } })
    if (!order) throw new DomainError('not_found')
    if (!allowedTransitions(order.status).includes(to)) {
      throw new DomainError('invalid_transition', `Cannot change an Order from ${order.status} to ${to}`)
    }
    if (to === 'shipped') {
      const unmatched = await tx.orderLine.count({ where: { organizationId, orderId, productId: null } })
      if (unmatched > 0) throw new DomainError('unmatched_lines')
    }

    const touched = await applyStockEffect(tx, organizationId, orderId, to)
    const reasons = to === 'cancelled' ? removeReasons(order.attentionReasons, ['shortage']) : order.attentionReasons
    await tx.order.updateMany({ where: { id: orderId, organizationId }, data: { status: to, attentionReasons: reasons } })
    await appendEvent(tx, {
      organizationId,
      type: 'order.status_changed',
      subject: { type: 'order', id: orderId },
      payload: { from: order.status, to, cause: 'user', factId: null, actor },
    })
    return markOffersForStockPush(tx, organizationId, touched)
  }, TX_OPTIONS)

  await requestStockPushAfterCommit(ctx, organizationId, connectionIds)
  // No sweep re-sends a status push in stage 1, so a failed enqueue here leaves the Channel behind (issue #13).
  await afterCommit(ctx, { job: ordersUpdateStatusRef.name, organizationId, orderId }, () =>
    ctx.queue.enqueue(ordersUpdateStatusRef, { organizationId, orderId }, { coalesceKey: coalesceKeys.ordersUpdateStatus(orderId) }),
  )
}
