import { createDb, withUtcSession } from '@hanza/db'
import { createTestDatabase } from '@hanza/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createProduct } from '../catalog/products'
import { shipmentsCreateJob } from '../jobs/shipments-create'
import { shipmentsTrackJob } from '../jobs/shipments-track'
import { changeOrderStatus } from '../orders/change-status'
import { importOrder } from '../orders/import'
import { claimDueStatusPushes } from '../orders/status-push'
import { createTestCarrier } from '../testing/carrier'
import { createTestContext, createTestOrganization, type TestContext } from '../testing/context'
import { databaseUrl } from '../testing/db-test'
import { buildOrder, createCarrierConnection, createTestConnection, jobRun, lockerShipment, orderLine, secondsUntilDue, testChannel, user } from '../testing/fixtures'
import { claimDueShipmentChecks } from './claims'
import { requestShipment } from './request'
import { databaseNow } from './schedule'

const carrier = createTestCarrier({ id: 'zone-carrier' })

/** Sessions two hours ahead of UTC in summer and one in winter: never equal to UTC, whenever the test runs. */
const ZONE = 'Europe/Warsaw'
/** How far the test machine's clock and the database's may differ; the fault this guards against is an hour or two. */
const CLOCK_SLACK_MS = 60_000

function nearNow(date: Date): void {
  expect(Math.abs(date.getTime() - Date.now())).toBeLessThan(CLOCK_SLACK_MS)
}

describe('withUtcSession', () => {
  it('adds the UTC time zone as the last startup option, after any the connection string carries', () => {
    const plain = new URL(withUtcSession('postgresql://hanza:secret@db.example:5432/hanza?schema=public'))
    expect(plain.searchParams.get('options')).toBe('-c TimeZone=UTC')
    expect(plain.searchParams.get('schema')).toBe('public')
    expect(`${plain.username}:${plain.password}@${plain.host}${plain.pathname}`).toBe('hanza:secret@db.example:5432/hanza')

    const zoned = new URL(withUtcSession(`postgresql://hanza@db.example/hanza?options=-c%20TimeZone%3D${encodeURIComponent(ZONE)}%20-c%20statement_timeout%3D5000`))
    expect(zoned.searchParams.get('options')).toBe(`-c TimeZone=${ZONE} -c statement_timeout=5000 -c TimeZone=UTC`)
  })
})

// A session gets a zone other than UTC in two ways an installation meets: the default of the server or the database
// (a Postgres set up on a machine in local time), and an option in DATABASE_URL. Both are tried, each on a context
// made the way the apps make theirs (`createDb`).
describe.skipIf(!databaseUrl)('times in a database whose sessions are not in UTC', () => {
  let database: { url: string; drop(): Promise<void> } | undefined
  const contexts: TestContext[] = []

  beforeAll(async () => {
    database = await createTestDatabase(databaseUrl!)
    const admin = createDb(database.url)
    try {
      // The name is of the throwaway form `createTestDatabase` made and checked.
      await admin.$executeRawUnsafe(`ALTER DATABASE "${new URL(database.url).pathname.slice(1)}" SET timezone TO '${ZONE}'`)
    } finally {
      await admin.$disconnect()
    }
  })

  afterAll(async () => {
    for (const ctx of contexts) await ctx.db.$disconnect()
    await database?.drop()
  })

  const cases = [
    ['the database default', () => database!.url],
    [
      'an option in the connection string',
      () => {
        const url = new URL(database!.url)
        url.searchParams.set('options', `-c TimeZone=${ZONE}`)
        return url.toString()
      },
    ],
  ] as const

  describe.each(cases)('set by %s', (_how, urlOf) => {
    let ctx: TestContext

    beforeAll(() => {
      ctx = createTestContext({ databaseUrl: urlOf(), connectors: [testChannel, carrier.connector] })
      contexts.push(ctx)
    })

    async function setup() {
      const org = await createTestOrganization(ctx.db)
      const channelId = await createTestConnection(ctx, org)
      const carrierId = await createCarrierConnection(ctx, org, 'zone-carrier')
      await createProduct(ctx, org, { sku: 'P', name: 'Product', stock: 10 }, user)
      const { orderId } = await importOrder(ctx, org, channelId, buildOrder({ lines: [orderLine('l1', { sku: 'P', quantity: 1 })] }))
      return { org, channelId, carrierId, orderId }
    }

    it('the database really defaults to another zone, and the session runs in UTC all the same', async () => {
      const [defaults] = await ctx.db.$queryRaw<Array<{ config: string[] | null }>>`
        SELECT s.setconfig AS "config" FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase
        WHERE d.datname = current_database() AND s.setrole = 0`
      expect(defaults?.config).toContain(`TimeZone=${ZONE}`)

      const [session] = await ctx.db.$queryRaw<Array<{ zone: string; offset: number }>>`
        SELECT current_setting('TimeZone') AS "zone", EXTRACT(TIMEZONE FROM now())::int AS "offset"`
      expect(session).toEqual({ zone: 'UTC', offset: 0 })
      nearNow(await databaseNow(ctx.db))
    })

    it('the request time sent to the Carrier is the real one, and the times the sweep compares still hold', async () => {
      const { org, carrierId, orderId } = await setup()
      const { shipmentId } = await requestShipment(ctx, org, orderId, lockerShipment(carrierId), user)

      // Written by Prisma from the database's clock, read back by Prisma: the real time, not one shifted by the zone.
      const requested = await ctx.db.shipment.findFirstOrThrow({ where: { id: shipmentId } })
      nearNow(requested.createdAt)
      nearNow(requested.nextCheckAt!)
      // Due at once for SQL's own clock too.
      const due = await secondsUntilDue(ctx, shipmentId)
      expect(due).toBeLessThanOrEqual(0)
      expect(due).toBeGreaterThan(-30)

      await shipmentsCreateJob.handler(ctx, { organizationId: org, shipmentId }, jobRun)

      // What the connector bounds its search for an earlier create with: a time after the real one finds nothing,
      // and the repeat buys a second parcel.
      const [sent] = carrier.calls.create.filter((request) => request.reference === shipmentId)
      expect(sent!.requestedAt).toBe(requested.createdAt.toISOString())
      nearNow(new Date(sent!.requestedAt))

      // A fresh unconfirmed Shipment is due again within half a tick, by the database's clock and by this one.
      const wait = await secondsUntilDue(ctx, shipmentId)
      expect(wait).toBeGreaterThan(0)
      expect(wait).toBeLessThanOrEqual(30)
      const stored = await ctx.db.shipment.findFirstOrThrow({ where: { id: shipmentId } })
      expect(stored.nextCheckAt!.getTime() - Date.now()).toBeLessThan(30_000 + CLOCK_SLACK_MS)
      expect(stored.nextCheckAt!.getTime() - Date.now()).toBeGreaterThan(-CLOCK_SLACK_MS)

      // A time Prisma writes from this process's clock and SQL's now() agree on what is due: neither two hours early
      // nor two hours late.
      await ctx.db.shipment.updateMany({ where: { id: shipmentId }, data: { nextCheckAt: new Date(Date.now() + 10 * 60_000) } })
      expect(await claimDueShipmentChecks(ctx, org, carrierId, 10)).toEqual([])
      await ctx.db.shipment.updateMany({ where: { id: shipmentId }, data: { nextCheckAt: new Date(Date.now() - 10 * 60_000) } })
      expect(await claimDueShipmentChecks(ctx, org, carrierId, 10)).toEqual([shipmentId])

      // And the job that follows it leaves a next check that is right on both clocks.
      await ctx.db.shipment.updateMany({ where: { id: shipmentId }, data: { nextCheckAt: new Date(Date.now() - 1_000) } })
      await shipmentsTrackJob.handler(ctx, { organizationId: org, connectionId: carrierId }, jobRun)
      const tracked = await secondsUntilDue(ctx, shipmentId)
      expect(tracked).toBeGreaterThan(0)
      expect(tracked).toBeLessThanOrEqual(30)
    })

    it('the pending Order status push, the other time the tick sweeps, is right as well', async () => {
      const { org, channelId, orderId } = await setup()
      await changeOrderStatus(ctx, org, orderId, 'processing', user)

      // Marked ten minutes ahead in SQL, and read through Prisma as that time.
      const marked = await ctx.db.order.findFirstOrThrow({ where: { id: orderId } })
      const ahead = marked.statusPushDueAt!.getTime() - Date.now()
      expect(ahead).toBeGreaterThan(10 * 60_000 - CLOCK_SLACK_MS)
      expect(ahead).toBeLessThan(10 * 60_000 + CLOCK_SLACK_MS)
      nearNow(marked.updatedAt)
      expect(await claimDueStatusPushes(ctx, org, channelId, 10)).toEqual([])

      // A due time written through Prisma is swept when it has passed, and not before.
      await ctx.db.order.updateMany({ where: { id: orderId }, data: { statusPushDueAt: new Date(Date.now() + 5 * 60_000) } })
      expect(await claimDueStatusPushes(ctx, org, channelId, 10)).toEqual([])
      await ctx.db.order.updateMany({ where: { id: orderId }, data: { statusPushDueAt: new Date(Date.now() - 5 * 60_000) } })
      expect(await claimDueStatusPushes(ctx, org, channelId, 10)).toEqual([orderId])
    })
  })
})
