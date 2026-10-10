import { Prisma, type Tx } from '@hanza/db'
import type { Actor } from '../actor'
import { appendEvent } from '../events'

export type ErasureCause = { cause: 'retention'; retentionDays: number } | { cause: 'erasure_request' }

/**
 * Erases the Buyer data of the given Orders that still have it and still match `where`, and records
 * one Event each. Keeps lines, amounts, status, dates and the shipping country. Their Shipments lose
 * what they hold of the Buyer: the Label, which prints a name and an address, and the destination a
 * person confirmed (ADR 0023); status and tracking number stay. Idempotent: an Order erased already
 * is skipped. Returns the ids it erased.
 */
export async function eraseBuyerDataOfOrders(
  tx: Tx,
  organizationId: string,
  orderIds: string[],
  where: Prisma.OrderWhereInput,
  reason: ErasureCause,
  actor: Actor,
  now: Date,
): Promise<string[]> {
  if (orderIds.length === 0) return []
  const erased = await tx.order.updateManyAndReturn({
    where: { ...where, organizationId, id: { in: orderIds }, buyerDataErasedAt: null },
    data: {
      buyerData: null,
      buyerEmailIndex: null,
      buyerDataErasedAt: now,
      buyerName: null,
      buyerEmail: null,
      buyerPhone: null,
      buyerLogin: null,
      shippingAddress: Prisma.DbNull,
      billingAddress: Prisma.DbNull,
    },
    select: { id: true },
  })
  const ids = erased.map((order) => order.id).sort()
  if (ids.length === 0) return []

  // A Channel's free-text note ("Buyer wrote: …") may quote the Buyer.
  await tx.orderChannelFact.updateMany({ where: { organizationId, orderId: { in: ids }, note: { not: null } }, data: { note: null } })
  await tx.shipment.updateMany({
    where: { organizationId, orderId: { in: ids } },
    data: { label: null, labelContentType: null, destination: null },
  })
  for (const id of ids) {
    await appendEvent(tx, { organizationId, type: 'order.buyer_data_erased', subject: { type: 'order', id }, payload: { ...reason, actor } })
  }
  return ids
}
