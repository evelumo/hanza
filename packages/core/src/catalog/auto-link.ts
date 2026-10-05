import type { Tx } from '@hanza/db'
import type { Actor } from '../actor'
import { appendEvent } from '../events'

/**
 * Links every never-linked Offer (`linkedBy` null) whose SKU equals the new
 * Product's, bumping its push sequence. Returns the Connections to push to.
 */
export async function autoLinkOffersBySku(
  tx: Tx,
  organizationId: string,
  product: { id: string; sku: string },
  actor: Actor,
): Promise<{ linked: number; connectionIds: string[] }> {
  const rows = await tx.$queryRaw<Array<{ id: string; connectionId: string }>>`
    UPDATE "offer"
    SET "productId" = ${product.id}, "linkedBy" = 'sku', "stockPushSeq" = "stockPushSeq" + 1, "updatedAt" = now()
    WHERE "id" IN (
      SELECT "id" FROM "offer"
      WHERE "organizationId" = ${organizationId} AND "sku" = ${product.sku} AND "linkedBy" IS NULL
      ORDER BY "id"
      FOR UPDATE)
    RETURNING "id", "connectionId"`
  for (const row of rows) {
    await appendEvent(tx, {
      organizationId,
      type: 'offer.linked',
      subject: { type: 'offer', id: row.id },
      payload: { productId: product.id, linkedBy: 'sku', actor },
    })
  }
  return { linked: rows.length, connectionIds: [...new Set(rows.map((row) => row.connectionId))] }
}
