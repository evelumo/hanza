import type { Db, Tx } from '@hanza/db'

export interface Availability {
  stock: number
  reserved: number
  available: number
}

const ZERO: Availability = { stock: 0, reserved: 0, available: 0 }

/**
 * Available = Σ Stock − Σ open Reservations, over every Warehouse or, with `warehouseIds`, over just
 * those (an empty list gives zeros). Products not found come back as zeros. One statement, so it
 * always reads one snapshot.
 */
export async function getAvailability(
  db: Db | Tx,
  organizationId: string,
  productIds: string[],
  warehouseIds?: string[],
): Promise<Map<string, Availability>> {
  const ids = [...new Set(productIds)]
  const result = new Map<string, Availability>()
  if (ids.length === 0) return result
  if (warehouseIds?.length === 0) {
    for (const id of ids) result.set(id, ZERO)
    return result
  }

  const client: Tx = db
  const all = warehouseIds === undefined
  const only = warehouseIds ?? []
  const rows = await client.$queryRaw<Array<{ productId: string; stock: bigint | number; reserved: bigint | number }>>`
    SELECT ids."id" AS "productId",
      COALESCE((SELECT SUM(s."units") FROM "stock" s
        WHERE s."organizationId" = ${organizationId} AND s."productId" = ids."id"
          AND (${all} OR s."warehouseId" = ANY(${only}::text[]))), 0) AS "stock",
      COALESCE((SELECT SUM(r."units") FROM "reservation" r
        WHERE r."organizationId" = ${organizationId} AND r."productId" = ids."id" AND r."status" = 'open'
          AND (${all} OR r."warehouseId" = ANY(${only}::text[]))), 0) AS "reserved"
    FROM unnest(${ids}::text[]) AS ids("id")`

  for (const row of rows) {
    const stock = Number(row.stock)
    const reserved = Number(row.reserved)
    result.set(row.productId, { stock, reserved, available: stock - reserved })
  }
  return result
}

/** Availability of one Product in each of these Warehouses (zeros where it has none). One statement. */
export async function getWarehouseAvailability(
  db: Db | Tx,
  organizationId: string,
  productId: string,
  warehouseIds: string[],
): Promise<Map<string, Availability>> {
  const ids = [...new Set(warehouseIds)]
  const result = new Map<string, Availability>()
  if (ids.length === 0) return result

  const client: Tx = db
  const rows = await client.$queryRaw<Array<{ warehouseId: string; stock: bigint | number; reserved: bigint | number }>>`
    SELECT ids."id" AS "warehouseId",
      COALESCE((SELECT SUM(s."units") FROM "stock" s
        WHERE s."organizationId" = ${organizationId} AND s."productId" = ${productId} AND s."warehouseId" = ids."id"), 0) AS "stock",
      COALESCE((SELECT SUM(r."units") FROM "reservation" r
        WHERE r."organizationId" = ${organizationId} AND r."productId" = ${productId} AND r."warehouseId" = ids."id"
          AND r."status" = 'open'), 0) AS "reserved"
    FROM unnest(${ids}::text[]) AS ids("id")`

  for (const row of rows) {
    const stock = Number(row.stock)
    const reserved = Number(row.reserved)
    result.set(row.warehouseId, { stock, reserved, available: stock - reserved })
  }
  return result
}
