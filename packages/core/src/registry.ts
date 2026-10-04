import type { JobDefinition } from './jobs'
import { systemPingJob } from './jobs/system-ping'

/** Every job the worker can run. */
export const jobs: JobDefinition[] = [systemPingJob as JobDefinition]

export function findJob(name: string): JobDefinition | undefined {
  return jobs.find((job) => job.name === name)
}
