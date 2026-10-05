import type { Actor } from '../actor'
import type { Context } from '../context'
import { appendEvent } from '../events'
import { TX_OPTIONS } from '../transaction'

/** About ten years; longer is the same as keeping the data. */
export const MAX_RETENTION_DAYS = 3650

export interface PrivacySettingsView {
  /** Null = Buyer data is kept until someone erases it (the default). */
  buyerDataRetentionDays: number | null
}

export async function getPrivacySettings(ctx: Context, organizationId: string): Promise<PrivacySettingsView> {
  const row = await ctx.db.privacySettings.findUnique({ where: { organizationId }, select: { buyerDataRetentionDays: true } })
  return { buyerDataRetentionDays: row?.buyerDataRetentionDays ?? null }
}

export function isValidRetentionDays(days: number | null): boolean {
  return days === null || (Number.isInteger(days) && days >= 1 && days <= MAX_RETENTION_DAYS)
}

/** The next `privacy.sweep` applies it; Orders already erased stay erased when it is lengthened or turned off. */
export async function setBuyerDataRetention(ctx: Context, organizationId: string, days: number | null, actor: Actor): Promise<void> {
  if (!isValidRetentionDays(days)) throw new RangeError(`Retention must be null or 1-${MAX_RETENTION_DAYS} days`)
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
