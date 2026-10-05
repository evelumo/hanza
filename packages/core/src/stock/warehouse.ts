import type { Db, Tx } from '@hanza/db'

/**
 * Get-or-create the organization's default Warehouse. Call it before opening a
 * transaction that touches Stock: inside one, a first-time insert would hold
 * the new row's lock until commit and could deadlock with another writer.
 */
export async function ensureDefaultWarehouse(db: Db | Tx, organizationId: string): Promise<string> {
  const client: Tx = db
  await client.$executeRaw`
    INSERT INTO "warehouse" ("id", "organizationId", "code", "name")
    VALUES (gen_random_uuid()::text, ${organizationId}, 'default', 'Main warehouse')
    ON CONFLICT ("organizationId", "code") DO NOTHING`
  return defaultWarehouseId(client, organizationId)
}

export async function defaultWarehouseId(tx: Tx, organizationId: string): Promise<string> {
  const warehouse = await tx.warehouse.findFirst({ where: { organizationId, code: 'default' }, select: { id: true } })
  if (!warehouse) throw new Error('Default Warehouse missing: call ensureDefaultWarehouse before the transaction')
  return warehouse.id
}
