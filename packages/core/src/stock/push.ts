import { Prisma, type Tx } from '@hanza/db'
import { afterCommit } from '../after-commit'
import type { Context } from '../context'
import { coalesceKeys, stockPushRef } from '../jobs/refs'
import { TX_OPTIONS } from '../transaction'

/**
 * An Order's Offers on its own Channel: those linked to the Products of its lines and those its lines name. They
 * are what that Channel counts on its own when the Order moves there (ADR 0023).
 */
export interface OrderOffers {
  connectionId: string
  productIds: string[]
  offerExternalIds: string[]
}

export async function orderOffers(tx: Tx, organizationId: string, orderId: string): Promise<OrderOffers | null> {
  const order = await tx.order.findFirst({
    where: { id: orderId, organizationId },
    select: { connectionId: true, lines: { where: { organizationId }, select: { productId: true, offerExternalId: true } } },
  })
  if (!order) return null
  const present = (values: Array<string | null>) => [...new Set(values.filter((value): value is string => value !== null))]
  return {
    connectionId: order.connectionId,
    productIds: present(order.lines.map((line) => line.productId)),
    offerExternalIds: present(order.lines.map((line) => line.offerExternalId)),
  }
}

/**
 * Bumps `stockPushSeq` of every Offer linked to these Products, in the
 * transaction that changed their Available. Rows are locked in id order so
 * concurrent bumps and Offer writes cannot deadlock on each other.
 *
 * `reassert` adds the linked Offers of one Order on its own Connection, whose number that Channel may have changed
 * itself although Available did not (ADR 0023); Offers of other Connections are left alone. Both sets go in this
 * one statement: a second locking pass in the same transaction would take rows out of id order.
 */
export async function markOffersForStockPush(
  tx: Tx,
  organizationId: string,
  productIds: string[],
  reassert?: OrderOffers | null,
): Promise<string[]> {
  const ids = [...new Set(productIds)]
  const own = reassert && (reassert.productIds.length > 0 || reassert.offerExternalIds.length > 0) ? reassert : null
  if (ids.length === 0 && !own) return []
  // Without `reassert` the statement is the one every change of Available has always run.
  const ownOffers = own
    ? Prisma.sql`OR ("connectionId" = ${own.connectionId} AND "productId" IS NOT NULL
        AND ("productId" = ANY(${own.productIds}::text[]) OR "externalId" = ANY(${own.offerExternalIds}::text[])))`
    : Prisma.empty
  const rows = await tx.$queryRaw<Array<{ connectionId: string }>>`
    UPDATE "offer" SET "stockPushSeq" = "stockPushSeq" + 1, "updatedAt" = now()
    WHERE "id" IN (
      SELECT "id" FROM "offer"
      WHERE "organizationId" = ${organizationId} AND ("productId" = ANY(${ids}::text[]) ${ownOffers})
      ORDER BY "id"
      FOR UPDATE)
    RETURNING "connectionId"`
  return [...new Set(rows.map((row) => row.connectionId))]
}

/**
 * Marks an Order's Offers on its own Connection when nothing changed Available: the Channel was told a status and
 * may have moved its own count with it (ADR 0023). Takes Offer locks only (ADR 0017, step 4). Returns the
 * Connection to push, if any of its Offers was marked.
 */
export async function reassertOrderStock(ctx: Context, organizationId: string, orderId: string): Promise<string[]> {
  return ctx.db.$transaction(
    async (tx) => markOffersForStockPush(tx, organizationId, [], await orderOffers(tx, organizationId, orderId)),
    TX_OPTIONS,
  )
}

/**
 * Bumps `stockPushSeq` of every linked Offer of one Connection, in the transaction that changed what
 * its Channel is told (its stock rules or its Warehouses). Rows are locked in id order, as above.
 */
export async function markConnectionOffersForStockPush(tx: Tx, organizationId: string, connectionId: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE "offer" SET "stockPushSeq" = "stockPushSeq" + 1, "updatedAt" = now()
    WHERE "id" IN (
      SELECT "id" FROM "offer"
      WHERE "organizationId" = ${organizationId} AND "connectionId" = ${connectionId} AND "productId" IS NOT NULL
      ORDER BY "id"
      FOR UPDATE)`
}

/** Enqueues a coalesced `stock.push` per Connection. Call after commit. */
export async function requestStockPush(ctx: Context, organizationId: string, connectionIds: string[]): Promise<void> {
  for (const connectionId of new Set(connectionIds)) {
    await ctx.queue.enqueue(stockPushRef, { organizationId, connectionId }, { coalesceKey: coalesceKeys.stockPush(connectionId) })
  }
}

/**
 * `requestStockPush` for services right after their commit: a failed enqueue
 * is logged and never fails the operation, because the tick's 10-minute sweep
 * pushes every Offer whose push sequence is still ahead.
 */
export async function requestStockPushAfterCommit(ctx: Context, organizationId: string, connectionIds: string[]): Promise<void> {
  for (const connectionId of new Set(connectionIds)) {
    await afterCommit(ctx, { job: stockPushRef.name, organizationId, connectionId }, () => requestStockPush(ctx, organizationId, [connectionId]))
  }
}
