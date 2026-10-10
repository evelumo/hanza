import type { Tx } from '@hanza/db'

export interface LockedWarehouse {
  id: string
  active: boolean
}

// The Warehouses each open transaction has share-locked, keyed by its transaction client.
const lockedInTx = new WeakMap<Tx, LockedWarehouse[]>()

/**
 * Locks for a writer of Stock or Reservations, in the fixed order of ADR 0004 and ADR 0017: (the
 * caller's Order row first, then) the organization's Warehouse rows FOR SHARE in id order, then the
 * Stock rows of these Products in those Warehouses, sorted by Product then Warehouse, creating
 * missing rows first. Returns the share-locked Warehouses by id: only these may be written in this
 * transaction, and none of them can be deactivated or deleted until it ends.
 *
 * Pass every Product of the transaction to the first call; a later call must name a subset. The
 * Warehouses are read on the first call only, so a Warehouse created while the transaction runs is
 * never locked after a Stock row (that is what keeps a later call from waiting on a newer writer).
 *
 * A Product with no Stock row at all has unset Stock (#137), and a Reservation must not set it: the rows
 * created for such a Product are deleted again right after they are locked. The transaction still holds
 * them, so every other writer of the Product, whose insert of the same rows waits for this transaction,
 * stays serialised behind it; they are gone once it commits. Only `lockStockForWrite` keeps them.
 */
export async function lockStock(tx: Tx, organizationId: string, productIds: string[]): Promise<LockedWarehouse[]> {
  return (await lock(tx, organizationId, productIds, false)).warehouses
}

/**
 * `lockStock` for a writer of Stock units (setting Stock): the rows it creates stay, so from then on
 * every one of these Products has Stock (0 where nothing was saved). Also returns the Products whose
 * Stock was unset until this call.
 */
export async function lockStockForWrite(
  tx: Tx,
  organizationId: string,
  productIds: string[],
): Promise<{ warehouses: LockedWarehouse[]; unset: Set<string> }> {
  return lock(tx, organizationId, productIds, true)
}

async function lock(
  tx: Tx,
  organizationId: string,
  productIds: string[],
  keepCreatedRows: boolean,
): Promise<{ warehouses: LockedWarehouse[]; unset: Set<string> }> {
  assertTransaction(tx)
  const ids = [...new Set(productIds)].sort()
  if (ids.length === 0) return { warehouses: lockedInTx.get(tx) ?? [], unset: new Set() }

  let warehouses = lockedInTx.get(tx)
  if (!warehouses) {
    warehouses = await tx.$queryRaw<LockedWarehouse[]>`
      SELECT "id", "active" FROM "warehouse"
      WHERE "organizationId" = ${organizationId}
      ORDER BY "id"
      FOR SHARE`
    lockedInTx.set(tx, warehouses)
  }
  const warehouseIds = warehouses.map((warehouse) => warehouse.id)

  const created = await tx.$queryRaw<Array<{ id: string; productId: string }>>`
    INSERT INTO "stock" ("id", "organizationId", "productId", "warehouseId", "units", "updatedAt")
    SELECT gen_random_uuid()::text, p."organizationId", p."id", w."id", 0, now()
    FROM "product" p
    JOIN "warehouse" w ON w."organizationId" = p."organizationId" AND w."id" = ANY(${warehouseIds}::text[])
    WHERE p."organizationId" = ${organizationId} AND p."id" = ANY(${ids}::text[])
    ORDER BY p."id", w."id"
    ON CONFLICT ("productId", "warehouseId") DO NOTHING
    RETURNING "id", "productId"`

  await tx.$queryRaw`
    SELECT "id" FROM "stock"
    WHERE "organizationId" = ${organizationId} AND "productId" = ANY(${ids}::text[]) AND "warehouseId" = ANY(${warehouseIds}::text[])
    ORDER BY "productId", "warehouseId"
    FOR UPDATE`

  const unset = new Set<string>()
  if (created.length === 0) return { warehouses, unset }
  // Read under the locks: a Product whose only rows are the ones just created had none before.
  const createdIds = created.map((row) => row.id)
  const createdFor = [...new Set(created.map((row) => row.productId))]
  const set = await tx.$queryRaw<Array<{ productId: string }>>`
    SELECT DISTINCT "productId" FROM "stock"
    WHERE "organizationId" = ${organizationId} AND "productId" = ANY(${createdFor}::text[]) AND NOT ("id" = ANY(${createdIds}::text[]))`
  const hasRows = new Set(set.map((row) => row.productId))
  for (const productId of createdFor) if (!hasRows.has(productId)) unset.add(productId)
  if (!keepCreatedRows && unset.size > 0) {
    const placeholders = created.filter((row) => unset.has(row.productId)).map((row) => row.id)
    await tx.$executeRaw`DELETE FROM "stock" WHERE "organizationId" = ${organizationId} AND "id" = ANY(${placeholders}::text[])`
  }
  return { warehouses, unset }
}

/**
 * The database client type-checks as a transaction client, but outside a transaction every statement
 * commits on its own: a row lock would be released at once, and the memo above would live on the
 * shared client for good. Prisma's transaction client has no `$disconnect`; the full client does.
 */
export function assertTransaction(tx: Tx): void {
  if (typeof (tx as { $disconnect?: unknown }).$disconnect === 'function') {
    throw new Error('Stock and Order locks need a transaction client, not the database client')
  }
}

/**
 * Locks the Order row; returns false when the organization has no such Order. Take it before any Stock lock.
 * NO KEY UPDATE is enough to serialise the Order's writers (it conflicts with itself) without blocking
 * inserts that only reference the Order.
 */
export async function lockOrder(tx: Tx, organizationId: string, orderId: string): Promise<boolean> {
  assertTransaction(tx)
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "order" WHERE "id" = ${orderId} AND "organizationId" = ${organizationId} FOR NO KEY UPDATE`
  return rows.length > 0
}
