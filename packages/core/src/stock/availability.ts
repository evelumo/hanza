import type { Db, Tx } from '@hanza/db'

export interface Availability {
  stock: number
  reserved: number
  available: number
}

/**
 * Available = Σ Stock over all Warehouses − Σ open Reservations; Products not
 * found come back as zeros. One statement, so it always reads one snapshot.
 */
export async function getAvailability(db: Db | Tx, organizationId: string, productIds: string[]): Promise<Map<string, Availability>> {
  const ids = [...new Set(productIds)]
  const result = new Map<string, Availability>()
  if (ids.length === 0) return result

  const client: Tx = db
  const rows = await client.$queryRaw<Array<{ productId: string; stock: bigint | number; reserved: bigint | number }>>`
    SELECT ids."id" AS "productId",
      COALESCE((SELECT SUM(s."units") FROM "stock" s
        WHERE s."organizationId" = ${organizationId} AND s."productId" = ids."id"), 0) AS "stock",
      COALESCE((SELECT SUM(r."units") FROM "reservation" r
        WHERE r."organizationId" = ${organizationId} AND r."productId" = ids."id" AND r."status" = 'open'), 0) AS "reserved"
    FROM unnest(${ids}::text[]) AS ids("id")`

  for (const row of rows) {
    const stock = Number(row.stock)
    const reserved = Number(row.reserved)
    result.set(row.productId, { stock, reserved, available: stock - reserved })
  }
  return result
}
