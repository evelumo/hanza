import type { Tx } from '@hanza/db'
import type { Context } from '../context'
import { coalesceKeys, stockPushRef } from '../jobs/refs'

/**
 * Bumps `stockPushSeq` of every Offer linked to these Products, in the
 * transaction that changed their Available. Rows are locked in id order so
 * concurrent bumps and Offer writes cannot deadlock on each other.
 */
export async function markOffersForStockPush(tx: Tx, organizationId: string, productIds: string[]): Promise<string[]> {
  const ids = [...new Set(productIds)]
  if (ids.length === 0) return []
  const rows = await tx.$queryRaw<Array<{ connectionId: string }>>`
    UPDATE "offer" SET "stockPushSeq" = "stockPushSeq" + 1, "updatedAt" = now()
    WHERE "id" IN (
      SELECT "id" FROM "offer"
      WHERE "organizationId" = ${organizationId} AND "productId" = ANY(${ids}::text[])
      ORDER BY "id"
      FOR UPDATE)
    RETURNING "connectionId"`
  return [...new Set(rows.map((row) => row.connectionId))]
}

/** Enqueues a coalesced `stock.push` per Connection. Call after commit. */
export async function requestStockPush(ctx: Context, organizationId: string, connectionIds: string[]): Promise<void> {
  for (const connectionId of new Set(connectionIds)) {
    await ctx.queue.enqueue(stockPushRef, { organizationId, connectionId }, { coalesceKey: coalesceKeys.stockPush(connectionId) })
  }
}
