import { z } from 'zod'
import type { JobRef } from '../jobs'

const id = z.string().min(1)

/** Advances one run by one step; coalesced per run. */
export const workflowStepRef = {
  name: 'workflow.step',
  schema: z.object({ organizationId: id, runId: id }),
} satisfies JobRef

/** Enqueued by `sync.tick`: re-enqueues every run that is due (timers, signals, lost jobs, expired leases). */
export const workflowSweepRef = {
  name: 'workflow.sweep',
  schema: z.object({}),
} satisfies JobRef

export const workflowCoalesceKeys = {
  step: (runId: string) => `workflow.step:${runId}`,
  sweep: 'workflow.sweep',
}
