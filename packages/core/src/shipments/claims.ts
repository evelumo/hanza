import { SHIPMENT_CREATE_RETRY_DELAY_MS } from '@hanza/connector-sdk'
import type { Context } from '../context'
import { SHIPMENT_RETRY_MS } from './schedule'

// Who takes a due Shipment (ADR 0023). All times are the database's, as for the Order's status push (ADR 0012).

/**
 * For `sync.tick`: claims the Connection's Shipments still waiting for their Carrier's answer by moving their due time
 * one retry interval ahead, so a Shipment is enqueued at most once per interval whatever happens to its job. Rows
 * locked by a writer are skipped until the next tick, and so is a Shipment whose create lease is in force: its job
 * would do nothing, and the claim would only postpone the one that may ask.
 */
export async function claimDueShipmentCreates(ctx: Context, organizationId: string, connectionId: string, limit: number): Promise<string[]> {
  const rows = await ctx.db.$queryRaw<Array<{ id: string }>>`
    UPDATE "shipment"
    SET "nextCheckAt" = now() + ${SHIPMENT_RETRY_MS}::integer * interval '1 millisecond'
    WHERE "id" IN (
      SELECT "id" FROM "shipment"
      WHERE "organizationId" = ${organizationId} AND "connectionId" = ${connectionId} AND "nextCheckAt" <= now()
        AND "status" = 'requested' AND "externalId" IS NULL
        AND ("createLeaseUntil" IS NULL OR "createLeaseUntil" <= now())
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
 * Puts off the next check of Shipments that are not final by one retry interval: for a Shipment whose cancel failed
 * and will not be retried soon, so the Carrier is asked to cancel it once per interval and not at every check.
 */
export async function postponeShipmentChecks(ctx: Context, organizationId: string, shipmentIds: string[]): Promise<void> {
  if (shipmentIds.length === 0) return
  await ctx.db.$executeRaw`
    UPDATE "shipment" SET "nextCheckAt" = now() + ${SHIPMENT_RETRY_MS}::integer * interval '1 millisecond'
    WHERE "organizationId" = ${organizationId} AND "id" = ANY(${shipmentIds}::text[]) AND "nextCheckAt" IS NOT NULL`
}

// The create lease (`createLeaseUntil`). While it is in force no job asks the Carrier to create the Shipment, nothing
// cancels it without asking and the 24 hour timeout does not fire. It is taken for the SDK's retry delay when a job
// starts asking, and what the call does decides what becomes of it:
// - an answer is stored: the lease ends with the row leaving `requested`;
// - the call failed before anything that could make a Shipment was sent: the lease is given back (`release`);
// - anything else, a job that died included: the lease stays, counted again from the failure (`hold`), because a
//   Carrier without an idempotency key is only safe to ask again once its own list shows the earlier Shipment
//   (`SHIPMENT_CREATE_RETRY_DELAY_MS` in the SDK's contract of `shipments.create`).

/**
 * Takes the create lease of a Shipment still waiting for its Carrier's answer, counting the attempt. Null when it is
 * not waiting any more or the lease is in force: two jobs asking a Carrier at once, or one asking too soon after
 * another, is the one case a connector's lookup by `reference` cannot make safe. An earlier attempt that left the row
 * waiting ended without an answer, which the row now says (`createOutcomeUnknown`). The row is due again when the
 * lease runs out, so the sweep brings it back if this job dies. Returns the lease, to hold or release exactly this one.
 */
export async function claimShipmentCreate(ctx: Context, organizationId: string, shipmentId: string): Promise<Date | null> {
  const rows = await ctx.db.$queryRaw<Array<{ createLeaseUntil: Date }>>`
    UPDATE "shipment"
    SET "createOutcomeUnknown" = "createOutcomeUnknown" OR "createAttempts" > 0,
      "createAttempts" = "createAttempts" + 1,
      "createLeaseUntil" = now() + ${SHIPMENT_CREATE_RETRY_DELAY_MS}::integer * interval '1 millisecond',
      "nextCheckAt" = now() + ${SHIPMENT_CREATE_RETRY_DELAY_MS}::integer * interval '1 millisecond'
    WHERE "id" = ${shipmentId} AND "organizationId" = ${organizationId}
      AND "status" = 'requested' AND "externalId" IS NULL
      AND ("createLeaseUntil" IS NULL OR "createLeaseUntil" <= now())
    RETURNING "createLeaseUntil"`
  return rows[0]?.createLeaseUntil ?? null
}

/**
 * After a create call whose outcome is not known (it threw, or its answer could not be stored): nobody asks again
 * until the retry delay has passed, counted from now, which is later than when the call started. The Shipment is due
 * then, and says that one may exist at the Carrier. Returns false when the lease was not this one any more.
 */
export async function holdShipmentCreate(ctx: Context, organizationId: string, shipmentId: string, lease: Date): Promise<boolean> {
  const held = await ctx.db.$executeRaw`
    UPDATE "shipment"
    SET "createOutcomeUnknown" = true,
      "createLeaseUntil" = now() + ${SHIPMENT_CREATE_RETRY_DELAY_MS}::integer * interval '1 millisecond',
      "nextCheckAt" = now() + ${SHIPMENT_CREATE_RETRY_DELAY_MS}::integer * interval '1 millisecond'
    WHERE "id" = ${shipmentId} AND "organizationId" = ${organizationId}
      AND "status" = 'requested' AND "externalId" IS NULL AND "createLeaseUntil" = ${lease}`
  return held === 1
}

/**
 * Gives back the lease of a create call that provably never asked the Carrier for a Shipment (Hanza's own rate
 * limiter refused the request before sending it): the attempt is not counted, and the job's retry may ask at once.
 */
export async function releaseShipmentCreate(ctx: Context, organizationId: string, shipmentId: string, lease: Date): Promise<void> {
  await ctx.db.$executeRaw`
    UPDATE "shipment"
    SET "createLeaseUntil" = NULL, "createAttempts" = GREATEST("createAttempts" - 1, 0), "nextCheckAt" = now()
    WHERE "id" = ${shipmentId} AND "organizationId" = ${organizationId}
      AND "status" = 'requested' AND "externalId" IS NULL AND "createLeaseUntil" = ${lease}`
}
