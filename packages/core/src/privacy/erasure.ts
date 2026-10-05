import type { Prisma } from '@hanza/db'
import type { Actor } from '../actor'
import type { Context } from '../context'
import { appendEvent } from '../events'
import { FINAL_STATUSES, isFinalStatus } from '../orders/status-rules'
import { TX_OPTIONS } from '../transaction'
import { eraseBuyerDataOfOrders } from './erase'
import { buyerEmailIndex, normalizeEmail } from './buyer-data'

/**
 * Buyers are not linked across Orders, so a request names one email and matches it exactly
 * (trimmed, case-insensitive) within the organization. Legacy rows not sealed yet match on the plaintext column.
 */
function matchingOrders(ctx: Context, organizationId: string, email: string): Prisma.OrderWhereInput {
  return {
    organizationId,
    buyerDataErasedAt: null,
    OR: [
      { buyerEmailIndex: buyerEmailIndex(ctx.secrets, email) },
      { buyerData: null, buyerEmail: { equals: normalizeEmail(email), mode: 'insensitive' } },
    ],
  }
}

const closed = { status: { in: [...FINAL_STATUSES] } } satisfies Prisma.OrderWhereInput

export interface ErasurePreview {
  /** Shipped or cancelled: erased on confirmation. */
  closed: number
  /** New or processing: kept, their address is needed to ship. */
  open: number
}

export async function previewBuyerErasure(ctx: Context, organizationId: string, email: string): Promise<ErasurePreview> {
  const where = matchingOrders(ctx, organizationId, email)
  const [all, closedCount] = await Promise.all([
    ctx.db.order.count({ where }),
    ctx.db.order.count({ where: { AND: [where, closed] } }),
  ])
  return { closed: closedCount, open: all - closedCount }
}

/**
 * Handles an erasure request for one email now: erases the Buyer data of its closed Orders and
 * reports the open ones. Records an Event per Order and one for the request, never the email.
 */
export async function eraseBuyerData(
  ctx: Context,
  organizationId: string,
  email: string,
  actor: Actor,
): Promise<{ erased: number; keptOpen: number }> {
  const where = matchingOrders(ctx, organizationId, email)
  return ctx.db.$transaction(async (tx) => {
    const rows = await tx.order.findMany({ where, select: { id: true, status: true } })
    const closedIds = rows.filter((row) => isFinalStatus(row.status)).map((row) => row.id)
    const erased = await eraseBuyerDataOfOrders(tx, organizationId, closedIds, closed, { cause: 'erasure_request' }, actor, new Date())
    const result = { erased: erased.length, keptOpen: rows.length - closedIds.length }
    await appendEvent(tx, { organizationId, type: 'privacy.erasure_requested', subject: null, payload: { ...result, actor } })
    return result
  }, TX_OPTIONS)
}
