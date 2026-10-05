import { defineJob, type JobDefinition } from '../jobs'
import type { AnyWorkflowDefinition } from './define'
import { workflowStepRef, workflowSweepRef } from './refs'
import { advanceRun, sweepRuns } from './runner'

/** The two jobs of the stage-1 engine, able to advance runs of `workflows`. */
export function createWorkflowJobs(workflows: readonly AnyWorkflowDefinition[]): JobDefinition[] {
  const byName = new Map<string, AnyWorkflowDefinition>()
  for (const workflow of workflows) {
    if (byName.has(workflow.name)) throw new Error(`Workflow "${workflow.name}" is registered twice`)
    byName.set(workflow.name, workflow)
  }

  const step = defineJob({
    ...workflowStepRef,
    handler: (ctx, payload, run) => advanceRun(ctx, byName, payload, run),
  })
  const sweep = defineJob({
    ...workflowSweepRef,
    async handler(ctx) {
      const enqueued = await sweepRuns(ctx)
      if (enqueued > 0) ctx.log.info('workflow sweep', { enqueued })
    },
  })
  return [step, sweep] as JobDefinition[]
}
