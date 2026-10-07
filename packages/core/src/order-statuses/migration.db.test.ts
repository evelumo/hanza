import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDb, type Db } from '@hanza/db'
import { applyMigration, createTestDatabase, migrationNames } from '@hanza/db/testing'
import { describe, expect, it } from 'vitest'
import { databaseUrl } from '../testing/db-test'

const MIGRATION = '20261005210451_custom_order_statuses'
const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', '..', 'db', 'prisma', 'migrations')

type Seeded = {
  status: 'new' | 'processing' | 'shipped' | 'cancelled'
  awaitingPayment?: boolean
  /** sealed: Buyer data as `privacy` writes it; erased: cleared after closing; legacy: plaintext from before ADR 0016. */
  buyer?: 'sealed' | 'erased' | 'legacy'
  pendingPush?: boolean
  reasons?: string[]
}

// Rows shaped like the schema before the migration (the `status` column of type `order_status`, and every column the
// earlier migrations added), written in SQL because the Prisma client only knows the schema after it.
async function seedOrganization(db: Db, orders: Seeded[]): Promise<{ organizationId: string; orderIds: string[] }> {
  const organizationId = randomUUID()
  const connectionId = randomUUID()
  await db.$executeRaw`INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES (${organizationId}, 'Org', ${`org-${organizationId}`}, now())`
  await db.$executeRaw`
    INSERT INTO "connection" ("id", "organizationId", "connectorId", "name", "config", "credentials", "updatedAt")
    VALUES (${connectionId}, ${organizationId}, 'fake', 'Channel', '{}', 'sealed', now())`
  const orderIds: string[] = []
  for (const [index, order] of orders.entries()) {
    const id = randomUUID()
    const closed = order.status === 'shipped' || order.status === 'cancelled'
    const buyer = order.buyer ?? 'sealed'
    await db.$executeRawUnsafe(
      `INSERT INTO "order" ("id", "organizationId", "connectionId", "externalId", "status", "attentionReasons", "placedAt", "payment",
         "awaitingPayment", "currency", "totalAmount", "buyerData", "buyerEmailIndex", "shippingCountryCode", "closedAt",
         "buyerDataErasedAt", "buyerName", "shippingAddress", "statusPushSeq", "statusPushDueAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5::"order_status", $6::"attention_reason"[], now() - interval '3 days', 'prepaid',
         $7, 'PLN', 10.5, $8, $9, 'PL', $10, $11, $12, $13::jsonb, $14, $15, now() - interval '1 day')`,
      id,
      organizationId,
      connectionId,
      `order-${index}`,
      order.status,
      order.reasons ?? [],
      order.awaitingPayment === true,
      buyer === 'sealed' ? `v1:sealed-${index}` : null,
      buyer === 'sealed' ? `v1:index-${index}` : null,
      closed ? new Date(Date.now() - 2 * 86_400_000) : null,
      buyer === 'erased' ? new Date(Date.now() - 86_400_000) : null,
      buyer === 'legacy' ? 'Legacy Buyer' : null,
      buyer === 'legacy' ? '{"city":"Warsaw"}' : null,
      order.pendingPush ? 3 : 0,
      order.pendingPush ? new Date(Date.now() + 60_000) : null,
    )
    await db.$executeRaw`
      INSERT INTO "order_line" ("id", "organizationId", "orderId", "externalId", "name", "quantity", "unitPriceAmount")
      VALUES (${randomUUID()}, ${organizationId}, ${id}, 'l1', 'Line', 1, 10.5)`
    await db.$executeRaw`
      INSERT INTO "event_log" ("id", "organizationId", "type", "payload", "subjectType", "subjectId")
      VALUES (${randomUUID()}, ${organizationId}, 'order.status_changed', ${JSON.stringify({ from: 'new', to: order.status })}::jsonb, 'order', ${id})`
    orderIds.push(id)
  }
  return { organizationId, orderIds }
}

/** Every row of every table, as JSON, so "nothing else changed" can be checked. */
async function snapshot(db: Db): Promise<Map<string, unknown[]>> {
  const tables = await db.$queryRaw<Array<{ name: string }>>`SELECT tablename AS "name" FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`
  const all = new Map<string, unknown[]>()
  for (const { name } of tables) {
    const rows = await db.$queryRawUnsafe<Array<{ row: Record<string, unknown> }>>(`SELECT to_jsonb(t) AS "row" FROM "${name}" t ORDER BY to_jsonb(t)::text`)
    all.set(name, rows.map((entry) => entry.row))
  }
  return all
}

describe.skipIf(!databaseUrl)(`migration ${MIGRATION}`, () => {
  it('runs after every migration that still names the `status` column', async () => {
    const names = await migrationNames()
    expect(names).toContain(MIGRATION)
    // Later migrations must not name the Order's old column (`"status"`), which this one renames to `phase`.
    for (const later of names.filter((name) => name > MIGRATION)) {
      expect(await readFile(join(MIGRATIONS_DIR, later, 'migration.sql'), 'utf8'), later).not.toMatch(/"status"/)
    }
  })

  it('gives every organization its default statuses and moves every existing Order to the default of its phase, changing nothing else', async () => {
    const database = await createTestDatabase(databaseUrl!, { before: MIGRATION })
    const db = createDb(database.url)
    try {
      const a = await seedOrganization(db, [
        { status: 'new', pendingPush: true, reasons: ['unmatched_line'] },
        { status: 'new', awaitingPayment: true },
        { status: 'processing', pendingPush: true, reasons: ['shortage', 'status_push_failed'] },
        { status: 'shipped', buyer: 'erased' },
        { status: 'shipped', awaitingPayment: true, pendingPush: true },
        { status: 'cancelled', reasons: ['cancelled_while_processing'] },
        { status: 'processing', buyer: 'legacy' },
      ])
      const b = await seedOrganization(db, [{ status: 'shipped', pendingPush: true }, { status: 'cancelled', awaitingPayment: true, buyer: 'erased' }])
      const empty = await seedOrganization(db, [])
      // An organization Better Auth created whose members never got as far as a Connection.
      const authOnly = randomUUID()
      const userId = randomUUID()
      await db.$executeRaw`INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES (${authOnly}, 'Auth only', ${`org-${authOnly}`}, now())`
      await db.$executeRaw`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (${userId}, 'U', ${`${userId}@example.org`}, false, now(), now())`
      await db.$executeRaw`INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt") VALUES (${randomUUID()}, ${authOnly}, ${userId}, 'owner', now())`
      const before = await snapshot(db)

      await db.$disconnect()
      await applyMigration(database.url, MIGRATION)
      const after = createDb(database.url)
      try {
        for (const organizationId of [a.organizationId, b.organizationId, empty.organizationId, authOnly]) {
          const statuses = await after.orderStatus.findMany({ where: { organizationId }, orderBy: { phase: 'asc' } })
          expect(statuses.map((status) => [status.phase, status.name, status.color, status.isDefault, status.active, status.replacedById])).toEqual([
            ['new', null, null, true, true, null],
            ['processing', null, null, true, true, null],
            ['shipped', null, null, true, true, null],
            ['cancelled', null, null, true, true, null],
          ])
        }

        const orders = await after.order.findMany({
          select: { id: true, organizationId: true, phase: true, status: { select: { organizationId: true, phase: true, isDefault: true } } },
        })
        expect(orders).toHaveLength(9)
        const phaseOf = new Map(orders.map((order) => [order.id, order.phase]))
        expect(a.orderIds.map((id) => phaseOf.get(id))).toEqual(['new', 'new', 'processing', 'shipped', 'shipped', 'cancelled', 'processing'])
        expect(b.orderIds.map((id) => phaseOf.get(id))).toEqual(['shipped', 'cancelled'])
        for (const order of orders) {
          expect(order.status).toEqual({ organizationId: order.organizationId, phase: order.phase, isDefault: true })
        }

        // Nothing else changed: every other table row for row, and every Order column but the renamed one and statusId.
        const now = await snapshot(after)
        const statusIds = new Set((await after.orderStatus.findMany({ select: { id: true } })).map((status) => status.id))
        expect([...now.keys()].filter((table) => !before.has(table))).toEqual(['channel_status_mapping', 'order_status'])
        for (const [table, rows] of before) {
          if (table === 'order') continue
          expect(now.get(table), table).toEqual(rows)
        }
        const asBefore = (now.get('order') as Array<Record<string, unknown>>).map(({ phase, statusId, ...rest }) => {
          expect(statusIds.has(statusId as string)).toBe(true)
          return { ...rest, status: phase }
        })
        const byId = (rows: Array<Record<string, unknown>>) => [...rows].sort((x, y) => String(x.id).localeCompare(String(y.id)))
        expect(byId(asBefore)).toEqual(byId(before.get('order') as Array<Record<string, unknown>>))
      } finally {
        await after.$disconnect()
      }
    } finally {
      await db.$disconnect()
      await database.drop()
    }
  })
})
