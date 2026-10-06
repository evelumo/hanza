import type { Db, Tx } from '@hanza/db'
import { DomainError } from '../errors'
import type { OrderPhase } from '../orders/phases'

/**
 * What an Event keeps of a status: renaming it later never rewrites history. A null name is the phase's own name,
 * so the phase is kept too and the history shows it in the viewer's language.
 */
export type StatusSnapshot = { id: string; name: string | null; phase: OrderPhase }

type LockedStatus = StatusSnapshot & { active: boolean; replacedById: string | null }

export function snapshotOf(status: { id: string; name: string | null; phase: OrderPhase }): StatusSnapshot {
  return { id: status.id, name: status.name, phase: status.phase }
}

/**
 * Creates the organization's missing default statuses, one per phase, named after the phase (null name). Call it
 * before opening a transaction that gives an Order a status, like `ensureDefaultWarehouse`: inside one, a first-time
 * insert would hold the new rows' locks until commit.
 */
export async function ensureDefaultOrderStatuses(db: Db | Tx, organizationId: string): Promise<void> {
  const client: Tx = db
  await client.$executeRaw`
    INSERT INTO "order_status" ("id", "organizationId", "phase", "isDefault", "updatedAt")
    SELECT gen_random_uuid()::text, ${organizationId}, p."phase", true, now()
    FROM unnest(enum_range(NULL::"order_phase")) AS p("phase")
    WHERE NOT EXISTS (
      SELECT 1 FROM "order_status" s
      WHERE s."organizationId" = ${organizationId} AND s."phase" = p."phase" AND s."isDefault")
    ORDER BY p."phase"
    ON CONFLICT ("organizationId", "phase") WHERE "isDefault" DO NOTHING`
}

// The lookups below lock the status they return FOR KEY SHARE, as the foreign key check of the Order write will
// anyway: a status deleted meanwhile is skipped instead of failing that write, and deleting it waits for this transaction.

/** A status of the organization, locked for referencing; null when there is none (or it was just deleted). */
export async function lockedStatus(tx: Tx, organizationId: string, statusId: string): Promise<LockedStatus | null> {
  const rows = await tx.$queryRaw<LockedStatus[]>`
    SELECT "id", "name", "phase"::text AS "phase", "active", "replacedById" FROM "order_status"
    WHERE "id" = ${statusId} AND "organizationId" = ${organizationId}
    FOR KEY SHARE`
  return rows[0] ?? null
}

/**
 * Like `lockedStatus`, but FOR SHARE: it waits for a transaction that is deactivating the status or starting its
 * deletion (both lock it FOR NO KEY UPDATE), and then sees the result. For a Status mapping, which must never name a
 * status that is on its way out.
 */
export async function sharedStatus(tx: Tx, organizationId: string, statusId: string): Promise<LockedStatus | null> {
  const rows = await tx.$queryRaw<LockedStatus[]>`
    SELECT "id", "name", "phase"::text AS "phase", "active", "replacedById" FROM "order_status"
    WHERE "id" = ${statusId} AND "organizationId" = ${organizationId}
    FOR SHARE`
  return rows[0] ?? null
}

export async function defaultStatus(tx: Tx, organizationId: string, phase: OrderPhase): Promise<LockedStatus> {
  // A default changed by a commit after this statement's snapshot is skipped by the lock; the next statement sees the new one.
  for (let attempt = 0; attempt < 3; attempt++) {
    const rows = await tx.$queryRaw<LockedStatus[]>`
      SELECT "id", "name", "phase"::text AS "phase", "active", "replacedById" FROM "order_status"
      WHERE "organizationId" = ${organizationId} AND "phase" = ${phase}::"order_phase" AND "isDefault"
      FOR KEY SHARE`
    if (rows[0]) return rows[0]
  }
  throw new Error('Default Order status missing: call ensureDefaultOrderStatuses before the transaction')
}

/**
 * The status an Order of this Channel gets when the Channel reports `phase` (an import is phase new): the Status
 * mapping's when it names an active status, otherwise the phase default.
 */
export async function resolveStatusForPhase(tx: Tx, organizationId: string, connectionId: string, phase: OrderPhase): Promise<StatusSnapshot> {
  const mapped = await tx.$queryRaw<StatusSnapshot[]>`
    SELECT s."id", s."name", s."phase"::text AS "phase" FROM "channel_status_mapping" m
    JOIN "order_status" s ON s."id" = m."statusId" AND s."organizationId" = m."organizationId"
    WHERE m."organizationId" = ${organizationId} AND m."connectionId" = ${connectionId}
      AND m."phase" = ${phase}::"order_phase" AND s."active"
    FOR KEY SHARE OF s`
  if (mapped[0]) return mapped[0]
  return snapshotOf(await defaultStatus(tx, organizationId, phase))
}

/** A status of the organization, or `not_found`. */
export async function findStatus(tx: Tx | Db, organizationId: string, statusId: string) {
  const status = await tx.orderStatus.findFirst({
    where: { id: statusId, organizationId },
    select: { id: true, name: true, phase: true, active: true, isDefault: true, color: true, position: true, replacedById: true },
  })
  if (!status) throw new DomainError('not_found')
  return status
}

/** Whether a deletion still moves Orders to this status: it can then be neither deleted nor deactivated. */
export async function isPendingReplacement(tx: Tx, organizationId: string, statusId: string): Promise<boolean> {
  return (await tx.orderStatus.count({ where: { organizationId, replacedById: statusId } })) > 0
}
