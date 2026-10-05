import { Prisma } from '@hanza/db'
import { systemActor } from '../actor'
import type { Context } from '../context'
import { TX_OPTIONS } from '../transaction'
import { eraseBuyerDataOfOrders } from './erase'
import { readBuyerData, sealBuyerData, storedBuyerDataSelect } from './buyer-data'
import { getPrivacySettings } from './settings'

export const SWEEP_BATCH_SIZE = 200
export const SWEEP_MAX_BATCHES = 10

const DAY_MS = 86_400_000

/** Orders closed at or before this moment are past the retention period. */
export function retentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * DAY_MS)
}

/**
 * Seals one batch of Orders still stored in the legacy plaintext shape (written before ADR 0011).
 * The update is conditional on the row still being legacy, so it is safe to re-run and beside imports and erasures.
 */
export async function sealLegacyBuyerData(ctx: Context, organizationId: string, limit = SWEEP_BATCH_SIZE): Promise<number> {
  return ctx.db.$transaction(async (tx) => {
    const rows = await tx.order.findMany({
      where: { organizationId, buyerData: null, buyerDataErasedAt: null, buyerName: { not: null } },
      orderBy: { id: 'asc' },
      take: limit,
      select: { id: true, ...storedBuyerDataSelect },
    })
    let sealed = 0
    for (const row of rows) {
      const data = readBuyerData(ctx.secrets, row)
      if (data === null) continue
      const { count } = await tx.order.updateMany({
        where: { id: row.id, organizationId, buyerData: null, buyerDataErasedAt: null },
        data: {
          ...sealBuyerData(ctx.secrets, row, data),
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
    return sealed
  }, TX_OPTIONS)
}

/** Erases the Buyer data of one batch of Orders closed longer ago than the organization's retention period. */
export async function applyBuyerDataRetention(ctx: Context, organizationId: string, now: Date, limit = SWEEP_BATCH_SIZE): Promise<number> {
  const { buyerDataRetentionDays: days } = await getPrivacySettings(ctx, organizationId)
  if (days === null) return 0
  const eligible = { closedAt: { lte: retentionCutoff(now, days) } } satisfies Prisma.OrderWhereInput
  return ctx.db.$transaction(async (tx) => {
    const rows = await tx.order.findMany({
      where: { ...eligible, organizationId, buyerDataErasedAt: null },
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
 * One `privacy.sweep` run: seals legacy rows, then applies retention, a bounded number of batches each.
 * `more` = a batch came back full, so the caller should run it again.
 */
export async function sweepBuyerData(ctx: Context, organizationId: string, now: Date): Promise<{ sealed: number; erased: number; more: boolean }> {
  let sealed = 0
  let erased = 0
  let more = false
  for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch++) {
    const count = await sealLegacyBuyerData(ctx, organizationId)
    sealed += count
    more = count === SWEEP_BATCH_SIZE
    if (!more) break
  }
  if (!more) {
    for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch++) {
      const count = await applyBuyerDataRetention(ctx, organizationId, now)
      erased += count
      more = count === SWEEP_BATCH_SIZE
      if (!more) break
    }
  }
  return { sealed, erased, more }
}
