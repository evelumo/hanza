import { defineJob } from '../jobs'
import { coalesceKeys, privacySweepRef, privacyTickRef } from './refs'

export const PRIVACY_TICK_EVERY_MS = 3_600_000

/**
 * One global job, like `sync.tick` (ADR 0008): every organization gets a `privacy.sweep`, so a new
 * organization needs no schedule of its own. Reads organization ids only.
 */
export const privacyTickJob = defineJob({
  ...privacyTickRef,
  async handler(ctx) {
    const organizations = await ctx.db.organization.findMany({ select: { id: true }, orderBy: { id: 'asc' } })
    for (const { id } of organizations) {
      await ctx.queue.enqueue(privacySweepRef, { organizationId: id }, { coalesceKey: coalesceKeys.privacySweep(id) })
    }
  },
})
