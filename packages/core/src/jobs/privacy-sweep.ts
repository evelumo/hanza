import { defineJob } from '../jobs'
import { sweepBuyerData } from '../privacy/sweep'
import { coalesceKeys, privacySweepRef } from './refs'

/** Seals legacy plaintext Buyer data, then applies the organization's retention period (ADR 0016). */
export const privacySweepJob = defineJob({
  ...privacySweepRef,
  async handler(ctx, { organizationId }) {
    const result = await sweepBuyerData(ctx, organizationId, new Date())
    if (result.sealed > 0 || result.erased > 0) ctx.log.info('privacy sweep', { organizationId, ...result })
    if (result.more) {
      // Runs after this one (coalesced), so a large backlog never holds a worker slot for long.
      await ctx.queue.enqueue(privacySweepRef, { organizationId }, { coalesceKey: coalesceKeys.privacySweep(organizationId) })
    }
  },
})
