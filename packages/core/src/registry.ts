import type { JobDefinition } from './jobs'
import { offersPullJob } from './jobs/offers-pull'
import { ordersPullJob } from './jobs/orders-pull'
import { ordersUpdateStatusJob } from './jobs/orders-update-status'
import { privacySweepJob } from './jobs/privacy-sweep'
import { privacyTickJob } from './jobs/privacy-tick'
import { stockPushJob } from './jobs/stock-push'
import { syncTickJob } from './jobs/sync-tick'
import { systemPingJob } from './jobs/system-ping'

/** Every job the worker can run. */
export const jobs: JobDefinition[] = [
  systemPingJob,
  syncTickJob,
  offersPullJob,
  ordersPullJob,
  stockPushJob,
  ordersUpdateStatusJob,
  privacyTickJob,
  privacySweepJob,
] as JobDefinition[]

export function findJob(name: string): JobDefinition | undefined {
  return jobs.find((job) => job.name === name)
}
