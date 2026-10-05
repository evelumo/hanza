import type { Prisma, Tx } from '@hanza/db'
import type { Actor } from '../actor'
import type { Context } from '../context'
import { appendEvent } from '../events'
import { FINAL_STATUSES, isFinalStatus } from '../orders/status-rules'
import { TX_OPTIONS } from '../transaction'
import { buyerEmailIndex, normalizeEmail } from './buyer-data'
import { eraseBuyerDataOfOrders } from './erase'
import { assertCanManagePrivacy } from './permissions'

/**
 * Ids of legacy rows (not sealed yet, or marked unsealable) whose plaintext email equals `email` after
 * the same normalisation as the blind index. Plain `=`, never LIKE/ILIKE: `_` and `%` are common in emails.
 */
async function legacyMatches(db: Tx | Context['db'], organizationId: string, email: string): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "order"
    WHERE "organizationId" = ${organizationId} AND "buyerData" IS NULL AND "buyerDataErasedAt" IS NULL
      AND "buyerEmail" IS NOT NULL AND lower(btrim(normalize("buyerEmail", NFC))) = ${normalizeEmail(email)}`
  return rows.map((row) => row.id)
}

/**
 * Buyers are not linked across Orders, so a request names one email and matches it exactly (Unicode NFC,
 * trimmed, case-insensitive) within the organization: sealed rows through the blind index, legacy rows on their plaintext.
 */
async function matchingOrders(ctx: Context, db: Tx | Context['db'], organizationId: string, email: string): Promise<Prisma.OrderWhereInput> {
  const legacyIds = await legacyMatches(db, organizationId, email)
  return {
    organizationId,
    buyerDataErasedAt: null,
    OR: [{ buyerEmailIndex: buyerEmailIndex(ctx.secrets, organizationId, email) }, { id: { in: legacyIds } }],
  }
}

const closed = { status: { in: [...FINAL_STATUSES] } } satisfies Prisma.OrderWhereInput

export interface ErasurePreview {
  /** Shipped or cancelled: erased on confirmation. */
  closed: number
  /** New or processing: kept, their address is needed to ship. */
  open: number
}

export async function previewBuyerErasure(ctx: Context, organizationId: string, email: string, actor: Actor): Promise<ErasurePreview> {
  await assertCanManagePrivacy(ctx, organizationId, actor)
  const where = await matchingOrders(ctx, ctx.db, organizationId, email)
  const [all, closedCount] = await Promise.all([
    ctx.db.order.count({ where }),
    ctx.db.order.count({ where: { AND: [where, closed] } }),
  ])
  return { closed: closedCount, open: all - closedCount }
}

/**
 * Handles an Erasure request for one email now: erases the Buyer data of its Closed Orders and
 * reports the open ones. Records an Event per Order and one for the request, never the email.
 */
export async function eraseBuyerData(
  ctx: Context,
  organizationId: string,
  email: string,
  actor: Actor,
): Promise<{ erased: number; keptOpen: number }> {
  await assertCanManagePrivacy(ctx, organizationId, actor)
  return ctx.db.$transaction(async (tx) => {
    const where = await matchingOrders(ctx, tx, organizationId, email)
    const rows = await tx.order.findMany({ where, select: { id: true, status: true } })
    const closedIds = rows.filter((row) => isFinalStatus(row.status)).map((row) => row.id)
    const erased = await eraseBuyerDataOfOrders(tx, organizationId, closedIds, closed, { cause: 'erasure_request' }, actor, new Date())
    const result = { erased: erased.length, keptOpen: rows.length - closedIds.length }
    await appendEvent(tx, { organizationId, type: 'privacy.erasure_requested', subject: null, payload: { ...result, actor } })
    return result
  }, TX_OPTIONS)
}
