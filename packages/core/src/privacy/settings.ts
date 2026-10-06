import type { Prisma } from '@hanza/db'
import type { Actor } from '../actor'
import type { Context } from '../context'
import { appendEvent } from '../events'
import { FINAL_STATUSES } from '../orders/status-rules'
import { TX_OPTIONS } from '../transaction'
import { assertCanManagePrivacy } from './permissions'

/** About ten years; longer is the same as keeping the data. */
export const MAX_RETENTION_DAYS = 3650

const DAY_MS = 86_400_000

export interface PrivacySettingsView {
  /** Null = Buyer data is kept until someone erases it (the default). */
  buyerDataRetentionDays: number | null
}

/** Orders closed at or before this moment are past the Retention period. */
export function retentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * DAY_MS)
}

/**
 * Closed Orders past the Retention period whose Buyer data is still there. A Closed Order without
 * `closedAt` (closed by code older than ADR 0016) counts from `updatedAt`, which the sweep copies into it.
 */
export function retentionEligible(now: Date, retentionDays: number): Prisma.OrderWhereInput {
  const cutoff = retentionCutoff(now, retentionDays)
  return {
    status: { in: [...FINAL_STATUSES] },
    buyerDataErasedAt: null,
    OR: [{ closedAt: { lte: cutoff } }, { closedAt: null, updatedAt: { lte: cutoff } }],
  }
}

export async function getPrivacySettings(ctx: Context, organizationId: string): Promise<PrivacySettingsView> {
  const row = await ctx.db.privacySettings.findUnique({ where: { organizationId }, select: { buyerDataRetentionDays: true } })
  return { buyerDataRetentionDays: row?.buyerDataRetentionDays ?? null }
}

export function isValidRetentionDays(days: number | null): boolean {
  return days === null || (Number.isInteger(days) && days >= 1 && days <= MAX_RETENTION_DAYS)
}

/** A new or shorter period can erase Buyer data at the next check, so the panel asks for confirmation first. */
export function retentionNeedsConfirmation(current: number | null, next: number | null): boolean {
  return next !== null && (current === null || next < current)
}

/** How many Orders would have their Buyer data erased at the next check if the period were `days`. */
export async function previewBuyerDataRetention(
  ctx: Context,
  organizationId: string,
  days: number,
  actor: Actor,
  now = new Date(),
): Promise<{ erasedAtNextCheck: number }> {
  if (!isValidRetentionDays(days)) throw new RangeError(`Retention must be 1-${MAX_RETENTION_DAYS} days`)
  await assertCanManagePrivacy(ctx, organizationId, actor)
  const erasedAtNextCheck = await ctx.db.order.count({ where: { ...retentionEligible(now, days), organizationId } })
  return { erasedAtNextCheck }
}

/** The next `privacy.sweep` applies it; Orders already erased stay erased when it is lengthened or turned off. */
export async function setBuyerDataRetention(ctx: Context, organizationId: string, days: number | null, actor: Actor): Promise<void> {
  if (!isValidRetentionDays(days)) throw new RangeError(`Retention must be null or 1-${MAX_RETENTION_DAYS} days`)
  await assertCanManagePrivacy(ctx, organizationId, actor)
  await ctx.db.$transaction(async (tx) => {
    const before = await tx.privacySettings.findUnique({ where: { organizationId }, select: { buyerDataRetentionDays: true } })
    const from = before?.buyerDataRetentionDays ?? null
    if (from === days) return
    await tx.privacySettings.upsert({
      where: { organizationId },
      create: { organizationId, buyerDataRetentionDays: days },
      update: { buyerDataRetentionDays: days },
    })
    await appendEvent(tx, { organizationId, type: 'privacy.retention_changed', subject: null, payload: { from, to: days, actor } })
  }, TX_OPTIONS)
}
