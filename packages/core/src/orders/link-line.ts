import type { Tx } from '@hanza/db'
import type { Actor } from '../actor'
import type { Context } from '../context'
import { DomainError } from '../errors'
import { appendEvent } from '../events'
import { lockOrder } from '../stock/locks'
import { markOffersForStockPush, requestStockPushAfterCommit } from '../stock/push'
import { reserveLine } from '../stock/reservations'
import { ensureDefaultWarehouse } from '../stock/warehouse'
import { TX_OPTIONS } from '../transaction'
import { addReasons, removeReasons } from './reasons'

/**
 * Links an Unmatched line to a Product by hand and reserves for it: an open Reservation on a new or
 * processing Order, a consumed one (Stock decreases) on a shipped Order, none on a cancelled Order.
 */
export async function linkOrderLine(ctx: Context, organizationId: string, orderLineId: string, productId: string, actor: Actor): Promise<void> {
  await ensureDefaultWarehouse(ctx.db, organizationId)
  const result = await ctx.db.$transaction(
    (tx) => linkLineInTx(tx, organizationId, orderLineId, productId, actor, { openOrdersOnly: false }),
    TX_OPTIONS,
  )
  await requestStockPushAfterCommit(ctx, organizationId, result?.connectionIds ?? [])
}

/**
 * Returns null when `openOrdersOnly` is set and the Order is no longer
 * new/processing (rematch must not touch shipped or cancelled Orders).
 */
export async function linkLineInTx(
  tx: Tx,
  organizationId: string,
  orderLineId: string,
  productId: string,
  actor: Actor,
  options: { openOrdersOnly: boolean },
): Promise<{ connectionIds: string[] } | null> {
  const found = await tx.orderLine.findFirst({ where: { id: orderLineId, organizationId }, select: { orderId: true } })
  if (!found) throw new DomainError('not_found')
  await lockOrder(tx, organizationId, found.orderId)

  // Read again under the Order lock: the line may have been linked meanwhile.
  const line = await tx.orderLine.findFirst({
    where: { id: orderLineId, organizationId },
    select: {
      productId: true,
      quantity: true,
      offerExternalId: true,
      order: { select: { id: true, status: true, connectionId: true, attentionReasons: true } },
    },
  })
  if (!line) throw new DomainError('not_found')
  if (line.productId !== null) throw new DomainError('already_linked')
  const product = await tx.product.findFirst({ where: { id: productId, organizationId }, select: { id: true } })
  if (!product) throw new DomainError('not_found')
  const { order } = line
  if (options.openOrdersOnly && order.status !== 'new' && order.status !== 'processing') return null

  await tx.orderLine.updateMany({ where: { id: orderLineId, organizationId }, data: { productId } })
  await appendEvent(tx, {
    organizationId,
    type: 'order.line_linked',
    subject: { type: 'order', id: order.id },
    payload: { orderLineId, productId, actor },
  })

  let availableChanged = false
  let shortage = false
  if (order.status !== 'cancelled') {
    const mode = order.status === 'shipped' ? 'consumed' : 'open'
    ;({ shortage } = await reserveLine(tx, organizationId, { orderId: order.id, orderLineId, productId, units: line.quantity }, mode))
    availableChanged = true
    if (shortage) await tx.orderLine.updateMany({ where: { id: orderLineId, organizationId }, data: { shortage: true } })
  }

  const offerLinked = line.offerExternalId
    ? await linkLineOffer(tx, organizationId, order.connectionId, line.offerExternalId, productId, actor)
    : false

  const stillUnmatched = await tx.orderLine.count({ where: { organizationId, orderId: order.id, productId: null } })
  let reasons = stillUnmatched === 0 ? removeReasons(order.attentionReasons, ['unmatched_line']) : order.attentionReasons
  if (shortage) {
    const next = addReasons(reasons, ['shortage'])
    reasons = next.reasons
    if (next.added.length > 0) {
      await appendEvent(tx, { organizationId, type: 'order.attention_raised', subject: { type: 'order', id: order.id }, payload: { reasons: next.added } })
    }
  }
  await tx.order.updateMany({ where: { id: order.id, organizationId }, data: { attentionReasons: reasons } })

  const connectionIds = availableChanged || offerLinked ? await markOffersForStockPush(tx, organizationId, [productId]) : []
  return { connectionIds }
}

/** Links the line's Offer to the same Product when that Offer is not linked yet. */
async function linkLineOffer(
  tx: Tx,
  organizationId: string,
  connectionId: string,
  offerExternalId: string,
  productId: string,
  actor: Actor,
): Promise<boolean> {
  // Lock the Offer together with the Product's other Offers in id order, as markOffersForStockPush does next.
  await tx.$queryRaw`
    SELECT "id" FROM "offer"
    WHERE "organizationId" = ${organizationId}
      AND ("productId" = ${productId} OR ("connectionId" = ${connectionId} AND "externalId" = ${offerExternalId}))
    ORDER BY "id"
    FOR UPDATE`
  const offer = await tx.offer.findFirst({
    where: { organizationId, connectionId, externalId: offerExternalId, productId: null },
    select: { id: true },
  })
  if (!offer) return false
  await tx.offer.updateMany({ where: { id: offer.id, organizationId }, data: { productId, linkedBy: 'manual' } })
  await appendEvent(tx, {
    organizationId,
    type: 'offer.linked',
    subject: { type: 'offer', id: offer.id },
    payload: { productId, linkedBy: 'manual', actor },
  })
  return true
}
