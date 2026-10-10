import type { Tx } from '@hanza/db'
import { TICK_EVERY_MS } from '../sync/schedule'
import { isFinalStatus, isUnconfirmed, type ShipmentStatus } from './statuses'

// When a Shipment is next asked for or checked: `nextCheckAt`, non-null while a job owes it something. Like the
// Order's pending status push (ADR 0012) it is the sweep's marker, and every time in it is the database's.

/**
 * How long after a check the next one is due. A Shipment the Carrier has not confirmed is checked every tick while it
 * is fresh, because a person is waiting for its Label. That is half a tick, not zero: the next tick finds it due, but
 * the run that just checked it does not take it again.
 */
export const SHIPMENT_CHECK_MS = {
  fresh: TICK_EVERY_MS / 2,
  unconfirmed: 600_000,
  ready: 900_000,
  handedOver: 3_600_000,
} as const

/** How long after it was requested an unconfirmed Shipment counts as fresh. */
export const SHIPMENT_FRESH_MS = 600_000

/** An unconfirmed Shipment this old fails with `carrier_timeout`: the Carrier will not confirm it any more. */
export const SHIPMENT_CONFIRM_TIMEOUT_MS = 24 * 3_600_000

/** A Shipment not final this long after it was requested is no longer checked; it keeps its last status. */
export const SHIPMENT_FOLLOW_MS = 60 * 24 * 3_600_000

/**
 * How far ahead a claim moves `nextCheckAt`: the grace for the job it enqueues, then the retry interval when that job
 * is lost or fails for good. The job writes the real next time once it has the Carrier's answer.
 */
export const SHIPMENT_RETRY_MS = 600_000

/** Most Shipments one `shipments.track` call asks about (the SDK's limit). */
export const SHIPMENT_TRACK_BATCH = 100

/** Most `shipments.create` jobs one Connection's sweep enqueues per tick; one while the Connection is failing, so a Carrier that is down is probed, not flooded. */
export const SHIPMENT_CREATE_SWEEP_LIMIT = 100
export const SHIPMENT_CREATE_SWEEP_LIMIT_FAILING = 1

export const CARRIER_TIMEOUT_CODE = 'carrier_timeout'

/** Whether the Carrier took too long to confirm a Shipment in `status` requested at `createdAt`. */
export function confirmationTimedOut(status: ShipmentStatus, createdAt: Date, now: Date): boolean {
  return isUnconfirmed(status) && now.getTime() - createdAt.getTime() >= SHIPMENT_CONFIRM_TIMEOUT_MS
}

/** When a Shipment just seen in `status` is due again; null when nothing more is owed to it. */
export function nextShipmentCheck(status: ShipmentStatus, createdAt: Date, now: Date): Date | null {
  if (isFinalStatus(status)) return null
  const age = now.getTime() - createdAt.getTime()
  if (age >= SHIPMENT_FOLLOW_MS) return null
  const wait = isUnconfirmed(status)
    ? age < SHIPMENT_FRESH_MS
      ? SHIPMENT_CHECK_MS.fresh
      : SHIPMENT_CHECK_MS.unconfirmed
    : status === 'ready'
      ? SHIPMENT_CHECK_MS.ready
      : SHIPMENT_CHECK_MS.handedOver
  return new Date(now.getTime() + wait)
}

/** The database's clock: the web and worker clocks never mix in `nextCheckAt` or in a Shipment's age. */
export async function databaseNow(db: Tx): Promise<Date> {
  const rows = await db.$queryRaw<Array<{ now: Date }>>`SELECT now() AS "now"`
  return rows[0]!.now
}
