import type { Tx } from '@hanza/db'

/**
 * Locks the Stock rows of these Products (all Warehouses) for the rest of the
 * transaction, creating missing default-Warehouse rows first. Every writer of
 * Stock or Reservations takes these locks, always sorted by Product, and after
 * the Order row lock if an Order is involved (§4.4) — that fixed order is what
 * keeps Hanza's own write paths from deadlocking.
 */
export async function lockStock(tx: Tx, organizationId: string, productIds: string[]): Promise<void> {
  const ids = [...new Set(productIds)].sort()
  if (ids.length === 0) return

  await tx.$executeRaw`
    INSERT INTO "stock" ("id", "organizationId", "productId", "warehouseId", "units", "updatedAt")
    SELECT gen_random_uuid()::text, p."organizationId", p."id", w."id", 0, now()
    FROM "product" p
    JOIN "warehouse" w ON w."organizationId" = p."organizationId" AND w."code" = 'default'
    WHERE p."organizationId" = ${organizationId} AND p."id" = ANY(${ids}::text[])
    ORDER BY p."id"
    ON CONFLICT ("productId", "warehouseId") DO NOTHING`

  await tx.$queryRaw`
    SELECT "id" FROM "stock"
    WHERE "organizationId" = ${organizationId} AND "productId" = ANY(${ids}::text[])
    ORDER BY "productId", "warehouseId"
    FOR UPDATE`
}

/** Locks the Order row; returns false when the organization has no such Order. Take it before any Stock lock. */
export async function lockOrder(tx: Tx, organizationId: string, orderId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "order" WHERE "id" = ${orderId} AND "organizationId" = ${organizationId} FOR UPDATE`
  return rows.length > 0
}
