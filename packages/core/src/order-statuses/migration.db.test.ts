import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hanza/db'
import { applyMigration, createTestDatabase } from '@hanza/db/testing'
import { describe, expect, it } from 'vitest'
import { databaseUrl } from '../testing/db-test'

const MIGRATION = '20261005201428_custom_order_statuses'

// Rows shaped like the schema before the migration (the `status` column of type `order_status`), written in SQL
// because the Prisma client only knows the schema after it.
async function seedOrganization(db: Db, orderStatuses: string[]): Promise<{ organizationId: string; orderIds: string[] }> {
  const organizationId = randomUUID()
  const connectionId = randomUUID()
  await db.$executeRaw`INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES (${organizationId}, 'Org', ${`org-${organizationId}`}, now())`
  await db.$executeRaw`
    INSERT INTO "connection" ("id", "organizationId", "connectorId", "name", "config", "credentials", "updatedAt")
    VALUES (${connectionId}, ${organizationId}, 'fake', 'Channel', '{}', 'sealed', now())`
  const orderIds: string[] = []
  for (const [index, status] of orderStatuses.entries()) {
    const id = randomUUID()
    await db.$executeRawUnsafe(
      `INSERT INTO "order" ("id", "organizationId", "connectionId", "externalId", "status", "placedAt", "payment", "currency", "totalAmount", "buyerName", "shippingAddress", "updatedAt")
       VALUES ($1, $2, $3, $4, $5::"order_status", now(), 'prepaid', 'PLN', 10, 'Buyer', '{}', now())`,
      id,
      organizationId,
      connectionId,
      `order-${index}`,
      status,
    )
    orderIds.push(id)
  }
  return { organizationId, orderIds }
}

describe.skipIf(!databaseUrl)(`migration ${MIGRATION}`, () => {
  it('gives every organization its default statuses and moves every existing Order to the default of its phase', async () => {
    const database = await createTestDatabase(databaseUrl!, { before: MIGRATION })
    const db = createDb(database.url)
    try {
      const a = await seedOrganization(db, ['new', 'processing', 'shipped', 'cancelled', 'processing'])
      const b = await seedOrganization(db, ['shipped'])
      const empty = await seedOrganization(db, [])

      await db.$disconnect()
      await applyMigration(database.url, MIGRATION)
      const after = createDb(database.url)
      try {
        for (const { organizationId } of [a, b, empty]) {
          const statuses = await after.orderStatus.findMany({ where: { organizationId }, orderBy: { phase: 'asc' } })
          expect(statuses.map((status) => [status.phase, status.name, status.color, status.isDefault, status.active])).toEqual([
            ['new', null, null, true, true],
            ['processing', null, null, true, true],
            ['shipped', null, null, true, true],
            ['cancelled', null, null, true, true],
          ])
        }

        const orders = await after.order.findMany({
          where: { organizationId: { in: [a.organizationId, b.organizationId] } },
          select: { id: true, organizationId: true, phase: true, status: { select: { organizationId: true, phase: true, isDefault: true } } },
        })
        expect(orders).toHaveLength(6)
        const phaseOf = new Map(orders.map((order) => [order.id, order.phase]))
        expect(a.orderIds.map((id) => phaseOf.get(id))).toEqual(['new', 'processing', 'shipped', 'cancelled', 'processing'])
        expect(b.orderIds.map((id) => phaseOf.get(id))).toEqual(['shipped'])
        for (const order of orders) {
          expect(order.status).toEqual({ organizationId: order.organizationId, phase: order.phase, isDefault: true })
        }
      } finally {
        await after.$disconnect()
      }
    } finally {
      await db.$disconnect()
      await database.drop()
    }
  })
})
