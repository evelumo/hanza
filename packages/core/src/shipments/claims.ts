import type { Context } from '../context'
import { SHIPMENT_RETRY_MS } from './schedule'

// Who takes a due Shipment (ADR 0023). All times are the database's, as for the Order's status push (ADR 0012).

/** How long one job may be asking the Carrier to create a Shipment before another may ask. A job that died holds it this long. */
export const SHIPMENT_CREATE_LEASE_MS = 300_000

/**
 * For `sync.tick`: claims the Connection's Shipments still waiting for their Carrier's answer by moving their due time
 * one retry interval ahead, so a Shipment is enqueued at most once per interval whatever happens to its job. Rows
 * locked by a writer are skipped until the next tick.
 */
export async function claimDueShipmentCreates(ctx: Context, organizationId: string, connectionId: string, limit: number): Promise<string[]> {
  const rows = await ctx.db.$queryRaw<Array<{ id: string }>>`
    UPDATE "shipment"
    SET "nextCheckAt" = now() + ${SHIPMENT_RETRY_MS}::integer * interval '1 millisecond'
    WHERE "id" IN (
      SELECT "id" FROM "shipment"
      WHERE "organizationId" = ${organizationId} AND "connectionId" = ${connectionId} AND "nextCheckAt" <= now()
        AND "status" = 'requested' AND "externalId" IS NULL
      ORDER BY "nextCheckAt", "id"
      LIMIT ${limit}
      FOR NO KEY UPDATE SKIP LOCKED)
    RETURNING "id"`
  return rows.map((row) => row.id).sort()
}

/** For `sync.tick`: whether the Connection has a Shipment at its Carrier that is due, so `shipments.track` has work. */
export async function hasDueShipmentChecks(ctx: Context, organizationId: string, connectionId: string): Promise<boolean> {
  const rows = await ctx.db.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "shipment"
    WHERE "organizationId" = ${organizationId} AND "connectionId" = ${connectionId} AND "nextCheckAt" <= now()
      AND "externalId" IS NOT NULL
    LIMIT 1`
  return rows.length > 0
}

/**
 * For `shipments.track`: claims up to `limit` due Shipments the Carrier knows, the same way, and returns their ids. The
 * job claims its own batch because its payload names the Connection, not the Shipments: a second run finds these moved
 * ahead and takes the next ones. `exclude` holds the ids this run has had already.
 */
export async function claimDueShipmentChecks(
  ctx: Context,
  organizationId: string,
  connectionId: string,
  limit: number,
  exclude: string[] = [],
): Promise<string[]> {
  const rows = await ctx.db.$queryRaw<Array<{ id: string }>>`
    UPDATE "shipment"
    SET "nextCheckAt" = now() + ${SHIPMENT_RETRY_MS}::integer * interval '1 millisecond'
    WHERE "id" IN (
      SELECT "id" FROM "shipment"
      WHERE "organizationId" = ${organizationId} AND "connectionId" = ${connectionId} AND "nextCheckAt" <= now()
        AND "externalId" IS NOT NULL AND NOT ("id" = ANY(${exclude}::text[]))
      ORDER BY "nextCheckAt", "id"
      LIMIT ${limit}
      FOR NO KEY UPDATE SKIP LOCKED)
    RETURNING "id"`
  return rows.map((row) => row.id).sort()
}

/**
 * Gives claimed Shipments back, due at once, when the call for them failed in a way the queue or a sign-in will
 * answer soon: without it the retries of the job would find nothing to do and the Connection would never be marked
 * failing. Only rows still claimed are touched.
 */
export async function releaseShipmentChecks(ctx: Context, organizationId: string, shipmentIds: string[]): Promise<void> {
  if (shipmentIds.length === 0) return
  await ctx.db.$executeRaw`
    UPDATE "shipment" SET "nextCheckAt" = now()
    WHERE "organizationId" = ${organizationId} AND "id" = ANY(${shipmentIds}::text[]) AND "nextCheckAt" IS NOT NULL`
}

/**
 * Takes the create lease of a Shipment still waiting for its Carrier's answer, counting the attempt. Null when it is
 * not waiting any more or another job holds the lease: two jobs asking a Carrier at once is the one case a
 * connector's lookup by `reference` cannot make safe. Returns the lease, to release exactly this one.
 */
export async function claimShipmentCreate(ctx: Context, organizationId: string, shipmentId: string): Promise<Date | null> {
  const rows = await ctx.db.$queryRaw<Array<{ createLeaseUntil: Date }>>`
    UPDATE "shipment"
    SET "createAttempts" = "createAttempts" + 1,
      "createLeaseUntil" = now() + ${SHIPMENT_CREATE_LEASE_MS}::integer * interval '1 millisecond'
    WHERE "id" = ${shipmentId} AND "organizationId" = ${organizationId}
      AND "status" = 'requested' AND "externalId" IS NULL
      AND ("createLeaseUntil" IS NULL OR "createLeaseUntil" <= now())
    RETURNING "createLeaseUntil"`
  return rows[0]?.createLeaseUntil ?? null
}

/** Ends a create lease whose call did not store an answer, so the job's retry may ask again at once. */
export async function releaseShipmentCreate(ctx: Context, organizationId: string, shipmentId: string, lease: Date): Promise<void> {
  await ctx.db.$executeRaw`
    UPDATE "shipment" SET "createLeaseUntil" = NULL
    WHERE "id" = ${shipmentId} AND "organizationId" = ${organizationId} AND "createLeaseUntil" = ${lease}`
}
