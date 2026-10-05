import type { Actor } from '../actor'
import type { Context } from '../context'
import { DomainError } from '../errors'
import { appendEvent } from '../events'
import { getWarehouseAvailability } from '../stock/availability'
import { lockOrder, lockStock } from '../stock/locks'
import { markOffersForStockPush, requestStockPushAfterCommit } from '../stock/push'
import { TX_OPTIONS } from '../transaction'
import { removeReasons } from './reasons'

/**
 * A person moves the open Reservation of a line of a new or processing Order to another active
 * Warehouse, any of the organization's. Refused (`not_enough_stock`) unless the target's Available
 * covers the whole line, so a move never makes a Shortage; it clears the line's Shortage mark, and
 * the Order's `shortage` reason once no line is short. Locks: Order, Warehouses, Stock (ADR 0013).
 * Every Channel of the Product is pushed: the Available of both Warehouses changed.
 */
export async function moveReservation(
  ctx: Context,
  organizationId: string,
  orderLineId: string,
  toWarehouseId: string,
  actor: Actor,
): Promise<void> {
  const connectionIds = await ctx.db.$transaction(async (tx) => {
    const found = await tx.orderLine.findFirst({ where: { id: orderLineId, organizationId }, select: { orderId: true } })
    if (!found) throw new DomainError('not_found')
    if (!(await lockOrder(tx, organizationId, found.orderId))) throw new DomainError('not_found')

    // Read again under the Order lock: the Order may have shipped or been cancelled meanwhile.
    const line = await tx.orderLine.findFirst({
      where: { id: orderLineId, organizationId },
      select: {
        shortage: true,
        order: { select: { id: true, status: true, attentionReasons: true } },
        reservation: { select: { id: true, productId: true, warehouseId: true, units: true, status: true } },
      },
    })
    if (!line) throw new DomainError('not_found')
    const { order, reservation } = line
    if (!reservation || reservation.status !== 'open' || (order.status !== 'new' && order.status !== 'processing')) {
      throw new DomainError('reservation_not_open')
    }
    if (reservation.warehouseId === toWarehouseId) return []

    const target = (await lockStock(tx, organizationId, [reservation.productId])).find((warehouse) => warehouse.id === toWarehouseId)
    if (!target) throw new DomainError('not_found')
    if (!target.active) throw new DomainError('warehouse_inactive')
    const available = (await getWarehouseAvailability(tx, organizationId, reservation.productId, [toWarehouseId])).get(toWarehouseId)
    if ((available?.available ?? 0) < reservation.units) throw new DomainError('not_enough_stock')

    await tx.reservation.updateMany({ where: { id: reservation.id, organizationId, status: 'open' }, data: { warehouseId: toWarehouseId } })
    await appendEvent(tx, {
      organizationId,
      type: 'order.reservation_moved',
      subject: { type: 'order', id: order.id },
      payload: {
        orderLineId,
        productId: reservation.productId,
        fromWarehouseId: reservation.warehouseId,
        toWarehouseId,
        units: reservation.units,
        actor,
      },
    })

    if (line.shortage) {
      await tx.orderLine.updateMany({ where: { id: orderLineId, organizationId }, data: { shortage: false } })
      const stillShort = await tx.orderLine.count({ where: { organizationId, orderId: order.id, shortage: true } })
      if (stillShort === 0 && order.attentionReasons.includes('shortage')) {
        await tx.order.updateMany({
          where: { id: order.id, organizationId },
          data: { attentionReasons: removeReasons(order.attentionReasons, ['shortage']) },
        })
        await appendEvent(tx, {
          organizationId,
          type: 'order.attention_resolved',
          subject: { type: 'order', id: order.id },
          payload: { cleared: ['shortage'], actor },
        })
      }
    }
    return markOffersForStockPush(tx, organizationId, [reservation.productId])
  }, TX_OPTIONS)

  await requestStockPushAfterCommit(ctx, organizationId, connectionIds)
}
