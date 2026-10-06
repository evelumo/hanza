import type { Tx } from '@hanza/db'
import { afterCommit } from '../after-commit'
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
