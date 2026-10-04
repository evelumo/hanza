import { z } from 'zod'
import { defineJob } from '../jobs'

/** Proves the web → queue → worker → database path works end to end. */
export const systemPingJob = defineJob({
  name: 'system.ping',
  schema: z.object({
    organizationId: z.string(),
    requestedBy: z.string(),
  }),
  async handler(ctx, payload) {
    await ctx.db.eventLog.create({
      data: {
        organizationId: payload.organizationId,
        type: 'system.ping',
        payload: { requestedBy: payload.requestedBy },
      },
    })
  },
})
