import { z } from 'zod'
import type { Context } from '../context'
import { defineWorkflow } from './define'

// The Event id is derived from the run and step, so a step that runs again records nothing new.
async function recordPing(ctx: Context, organizationId: string, id: string, payload: Record<string, string>): Promise<void> {
  await ctx.db.eventLog.createMany({ data: [{ id, organizationId, type: 'system.ping', payload }], skipDuplicates: true })
}

/**
 * Proves the workflow path end to end, like `system.ping` does for jobs: a step, a durable timer, and a
 * step that uses the first one's result.
 */
export const systemCheckWorkflow = defineWorkflow({
  name: 'system.check',
  input: z.object({ requestedBy: z.string().min(1) }),
})
  .step('ping', async ({ ctx, organizationId, runId, input }) => {
    const eventId = `${runId}:ping`
    await recordPing(ctx, organizationId, eventId, { requestedBy: input.requestedBy, workflowRunId: runId })
    return { eventId }
  })
  .sleep('pause', 1_000)
  .step('pong', async ({ ctx, organizationId, runId, input, results }) => {
    const eventId = `${runId}:pong`
    await recordPing(ctx, organizationId, eventId, { requestedBy: input.requestedBy, workflowRunId: runId, replyTo: results.ping.eventId })
    return { eventId }
  })
