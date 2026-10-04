import { systemActor } from '../actor'
import type { Context } from '../context'
import { DomainError } from '../errors'
import { requestStockPush } from '../stock/push'
import { ensureDefaultWarehouse } from '../stock/warehouse'
import { TX_OPTIONS } from '../transaction'
import { linkLineInTx } from './link-line'

const MAX_LINES = 500

/** Matches Unmatched lines of new/processing Orders again (§2) and links them as the system. */
export async function rematchUnmatchedLines(ctx: Context, organizationId: string): Promise<{ linked: number }> {
  // Only lines that match now count against the limit: otherwise 500 lines that
  // never match would hide every newer line from rematch for good. The match
  // rule is the one of `matchLines`: the linked Offer first, then the exact SKU
  // (line SKUs are stored normalised). Oldest Order first.
  const candidates = await ctx.db.$queryRaw<Array<{ lineId: string; productId: string }>>`
    SELECT l."id" AS "lineId", COALESCE(f."productId", p."id") AS "productId"
    FROM "order_line" l
    JOIN "order" o ON o."id" = l."orderId" AND o."organizationId" = ${organizationId}
    LEFT JOIN "offer" f
      ON f."organizationId" = ${organizationId} AND f."connectionId" = o."connectionId"
      AND f."externalId" = l."offerExternalId" AND f."productId" IS NOT NULL
    LEFT JOIN "product" p ON p."organizationId" = ${organizationId} AND p."sku" = l."sku"
    WHERE l."organizationId" = ${organizationId} AND l."productId" IS NULL
      AND o."status" IN ('new', 'processing')
      AND COALESCE(f."productId", p."id") IS NOT NULL
    ORDER BY l."orderId", l."id"
    LIMIT ${MAX_LINES}`
  if (candidates.length === 0) return { linked: 0 }
  await ensureDefaultWarehouse(ctx.db, organizationId)

  let linked = 0
  const connectionIds = new Set<string>()
  for (const candidate of candidates) {
    try {
      const result = await ctx.db.$transaction(
        (tx) => linkLineInTx(tx, organizationId, candidate.lineId, candidate.productId, systemActor, { openOrdersOnly: true }),
        TX_OPTIONS,
      )
      if (!result) continue
      linked++
      for (const connectionId of result.connectionIds) connectionIds.add(connectionId)
    } catch (error) {
      // Linked by someone else since the read above.
      if (error instanceof DomainError && error.code === 'already_linked') continue
      throw error
    }
  }
  await requestStockPush(ctx, organizationId, [...connectionIds])
  return { linked }
}

