import { Prisma } from '@hanza/db'
import { systemActor } from '../actor'
import type { Context } from '../context'
import { describeFailure } from '../describe-failure'
import { TX_OPTIONS } from '../transaction'
import { readBuyerData, sealBuyerData, storedBuyerDataSelect } from './buyer-data'
import { eraseBuyerDataOfOrders } from './erase'
import { getPrivacySettings, retentionEligible } from './settings'

export const SWEEP_BATCH_SIZE = 200
export const SWEEP_MAX_BATCHES = 10

/** Closed Orders closed by code older than ADR 0016 (e.g. during a deploy) get `closedAt` from their last change. */
export async function fillMissingClosedAt(ctx: Context, organizationId: string): Promise<number> {
  return ctx.db.$executeRaw`
    UPDATE "order" SET "closedAt" = "updatedAt"
    WHERE "organizationId" = ${organizationId} AND "status" IN ('shipped', 'cancelled') AND "closedAt" IS NULL`
}

/**
 * Seals one batch of Orders still stored in the legacy plaintext shape (written before ADR 0016).
 * Each row is its own conditional update, so it is safe to re-run and beside imports and erasures.
 * A row that fails the schema is marked and skipped from then on (its id is logged), so it never blocks
 * the batches behind it; it keeps its plaintext until it is erased, which clears it like any other.
 */
export async function sealLegacyBuyerData(
  ctx: Context,
  organizationId: string,
  limit = SWEEP_BATCH_SIZE,
  now = new Date(),
): Promise<{ sealed: number; failed: number; scanned: number }> {
  const rows = await ctx.db.order.findMany({
    where: { organizationId, buyerData: null, buyerDataErasedAt: null, buyerDataSealFailedAt: null, buyerName: { not: null } },
    orderBy: { id: 'asc' },
    take: limit,
    select: { id: true, ...storedBuyerDataSelect },
  })
  const legacy = { buyerData: null, buyerDataErasedAt: null } satisfies Prisma.OrderWhereInput
  let sealed = 0
  let failed = 0
  for (const row of rows) {
    let columns: ReturnType<typeof sealBuyerData>
    try {
      // Every row must leave the batch, sealed or marked; one skipped silently would be rescanned forever.
      const data = readBuyerData(ctx.secrets, row)
      if (data === null) throw new Error('Legacy row without Buyer data')
      columns = sealBuyerData(ctx.secrets, row, data)
    } catch (error) {
      failed++
      ctx.log.error('legacy buyer data not sealed', { organizationId, orderId: row.id, error: describeFailure(error) })
      await ctx.db.order.updateMany({ where: { id: row.id, organizationId, ...legacy }, data: { buyerDataSealFailedAt: now } })
      continue
    }
    const { count } = await ctx.db.order.updateMany({
      where: { id: row.id, organizationId, ...legacy },
      data: {
        ...columns,
        buyerName: null,
        buyerEmail: null,
        buyerPhone: null,
        buyerLogin: null,
        shippingAddress: Prisma.DbNull,
        billingAddress: Prisma.DbNull,
      },
    })
    sealed += count
  }
  return { sealed, failed, scanned: rows.length }
}

/** Erases the Buyer data of one batch of Closed Orders past the organization's Retention period. */
export async function applyBuyerDataRetention(ctx: Context, organizationId: string, now: Date, limit = SWEEP_BATCH_SIZE): Promise<number> {
  const { buyerDataRetentionDays: days } = await getPrivacySettings(ctx, organizationId)
  if (days === null) return 0
  const eligible = retentionEligible(now, days)
  return ctx.db.$transaction(async (tx) => {
    const rows = await tx.order.findMany({
      where: { ...eligible, organizationId },
      orderBy: [{ closedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true },
    })
    const ids = rows.map((row) => row.id)
    const erased = await eraseBuyerDataOfOrders(tx, organizationId, ids, eligible, { cause: 'retention', retentionDays: days }, systemActor, now)
    return erased.length
  }, TX_OPTIONS)
}

/**
 * One `privacy.sweep` run: fills missing `closedAt`, seals legacy rows, then applies retention, a bounded
 * number of batches each. Retention runs even while legacy rows remain. `more` = a batch came back full.
 */
export async function sweepBuyerData(
  ctx: Context,
  organizationId: string,
  now: Date,
): Promise<{ sealed: number; sealFailed: number; erased: number; more: boolean }> {
  await fillMissingClosedAt(ctx, organizationId)
  let sealed = 0
  let sealFailed = 0
  let sealMore = false
  for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch++) {
    const result = await sealLegacyBuyerData(ctx, organizationId, SWEEP_BATCH_SIZE, now)
    sealed += result.sealed
    sealFailed += result.failed
    sealMore = result.scanned === SWEEP_BATCH_SIZE
    if (!sealMore) break
  }
  let erased = 0
  let eraseMore = false
  for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch++) {
    const count = await applyBuyerDataRetention(ctx, organizationId, now)
    erased += count
    eraseMore = count === SWEEP_BATCH_SIZE
    if (!eraseMore) break
  }
  return { sealed, sealFailed, erased, more: sealMore || eraseMore }
}
