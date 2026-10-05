import type { Actor } from '../actor'
import { afterCommit } from '../after-commit'
import type { Context } from '../context'
import { DomainError } from '../errors'
import { appendEvent } from '../events'
import { coalesceKeys, ordersUpdateStatusRef } from '../jobs/refs'
import { defaultStatus, ensureDefaultOrderStatuses, lockedStatus } from '../order-statuses/defaults'
import { lockOrder } from '../stock/locks'
import { markOffersForStockPush, requestStockPushAfterCommit } from '../stock/push'
import { ensureDefaultWarehouse } from '../stock/warehouse'
import { TX_OPTIONS } from '../transaction'
import type { OrderPhase } from './phases'
import { removeReasons } from './reasons'
import { canMoveToStatus } from './status-rules'
import { markStatusPushPending } from './status-push'
import { applyStockEffect } from './stock-effect'

/** Where a person moves an Order: one of the organization's Order statuses, or a phase, meaning that phase's default status. */
export type StatusTarget = OrderPhase | { statusId: string }

/**
 * A person moves an Order to another status (`canMoveToStatus`); shipped is refused while an Unmatched line exists.
 * Only a change of phase does anything beyond the label (ADR 0014): cancelling releases the Reservations, shipping
 * consumes them, and the new phase is then pushed to the Channel, at once if the enqueue works, otherwise by the
 * tick's sweep of pending pushes (ADR 0011). A move within the phase pushes nothing and leaves the push marker alone.
 */
export async function changeOrderStatus(ctx: Context, organizationId: string, orderId: string, to: StatusTarget, actor: Actor): Promise<void> {
  await ensureDefaultWarehouse(ctx.db, organizationId)
  await ensureDefaultOrderStatuses(ctx.db, organizationId)

  const { connectionIds, pushable } = await ctx.db.$transaction(async (tx) => {
    if (!(await lockOrder(tx, organizationId, orderId))) throw new DomainError('not_found')
    const order = await tx.order.findFirst({
      where: { id: orderId, organizationId },
      select: {
        phase: true,
        statusId: true,
        attentionReasons: true,
        status: { select: { id: true, name: true } },
        connection: { select: { connectorId: true } },
      },
    })
    if (!order) throw new DomainError('not_found')
    const target = typeof to === 'string' ? await defaultStatus(tx, organizationId, to) : await lockedStatus(tx, organizationId, to.statusId)
    if (!target) throw new DomainError('not_found')
    if (!canMoveToStatus(order, target)) {
      throw new DomainError('invalid_transition', `Cannot change an Order from ${order.phase} to ${target.phase}`)
    }

    const phaseChanges = target.phase !== order.phase
    let touched: string[] = []
    let pushable = false
    if (phaseChanges) {
      if (target.phase === 'shipped') {
        const unmatched = await tx.orderLine.count({ where: { organizationId, orderId, productId: null } })
        if (unmatched > 0) throw new DomainError('unmatched_lines')
      }
      touched = await applyStockEffect(tx, organizationId, orderId, target.phase)
      const reasons = target.phase === 'cancelled' ? removeReasons(order.attentionReasons, ['shortage']) : order.attentionReasons
      await tx.order.updateMany({ where: { id: orderId, organizationId }, data: { phase: target.phase, statusId: target.id, attentionReasons: reasons } })
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
        fromStatus: order.status,
        toStatus: { id: target.id, name: target.name },
        cause: 'user',
        factId: null,
        actor,
      },
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
