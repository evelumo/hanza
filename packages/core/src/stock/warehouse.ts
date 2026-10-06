import type { Db, Tx } from '@hanza/db'

/** `code` of the Warehouse every organization gets automatically. */
export const DEFAULT_WAREHOUSE_CODE = 'default'

/**
 * Get-or-create the organization's default Warehouse. Call it before opening a
 * transaction that touches Stock: inside one, a first-time insert would hold
 * the new row's lock until commit and could deadlock with another writer.
 */
export async function ensureDefaultWarehouse(db: Db | Tx, organizationId: string): Promise<string> {
  const client: Tx = db
  await client.$executeRaw`
    INSERT INTO "warehouse" ("id", "organizationId", "code", "name")
    VALUES (gen_random_uuid()::text, ${organizationId}, ${DEFAULT_WAREHOUSE_CODE}, 'Main warehouse')
    ON CONFLICT ("organizationId", "code") DO NOTHING`
  return defaultWarehouseId(client, organizationId)
}

export async function defaultWarehouseId(tx: Tx, organizationId: string): Promise<string> {
  const warehouse = await tx.warehouse.findFirst({ where: { organizationId, code: DEFAULT_WAREHOUSE_CODE }, select: { id: true } })
  if (!warehouse) throw new Error('Default Warehouse missing: call ensureDefaultWarehouse before the transaction')
  return warehouse.id
}

/**
 * The Channel's Warehouses: the active Warehouses this Connection counts (every active one unless it
 * chose some), in placement order (priority, then id). Empty when the Connection does not exist. One
 * statement, so the choice and the active flags come from one snapshot (ADR 0017).
 */
export async function channelWarehouseIds(db: Db | Tx, organizationId: string, connectionId: string): Promise<string[]> {
  const client: Tx = db
  const rows = await client.$queryRaw<Array<{ id: string }>>`
    SELECT w."id" FROM "warehouse" w
    JOIN "connection" c ON c."id" = ${connectionId} AND c."organizationId" = ${organizationId}
    WHERE w."organizationId" = ${organizationId} AND w."active"
      AND (c."allWarehouses" OR EXISTS (
        SELECT 1 FROM "connection_warehouse" cw
        WHERE cw."organizationId" = ${organizationId} AND cw."connectionId" = c."id" AND cw."warehouseId" = w."id"))
    ORDER BY w."priority", w."id"`
  return rows.map((row) => row.id)
}
