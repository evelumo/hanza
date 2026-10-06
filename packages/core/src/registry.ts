import type { JobDefinition } from './jobs'
import { offersPullJob } from './jobs/offers-pull'
import { ordersPullJob } from './jobs/orders-pull'
import { ordersUpdateStatusJob } from './jobs/orders-update-status'
import { orderStatusesDeleteJob } from './jobs/order-statuses-delete'
import { pricePushJob } from './jobs/price-push'
import { privacySweepJob } from './jobs/privacy-sweep'
import { privacyTickJob } from './jobs/privacy-tick'
import { stockPushJob } from './jobs/stock-push'
import { syncTickJob } from './jobs/sync-tick'
import { systemPingJob } from './jobs/system-ping'
import type { AnyWorkflowDefinition } from './workflows/define'
import { createWorkflowJobs } from './workflows/jobs'
import { systemCheckWorkflow } from './workflows/system-check'

/** Every workflow the worker can run. */
export const workflows: AnyWorkflowDefinition[] = [systemCheckWorkflow]

/** Every job, with the workflow jobs able to advance runs of `workflowDefinitions`. */
export function buildJobs(workflowDefinitions: readonly AnyWorkflowDefinition[] = workflows): JobDefinition[] {
  return [
    systemPingJob,
    syncTickJob,
    offersPullJob,
    ordersPullJob,
    stockPushJob,
    pricePushJob,
    ordersUpdateStatusJob,
    orderStatusesDeleteJob,
    privacyTickJob,
    privacySweepJob,
    ...createWorkflowJobs(workflowDefinitions),
  ] as JobDefinition[]
}

/** Every job the worker can run. */
export const jobs: JobDefinition[] = buildJobs()

export function findJob(name: string): JobDefinition | undefined {
  return jobs.find((job) => job.name === name)
}
