import type { SyncStream } from '@hanza/db'

export const TICK_EVERY_MS = 60_000

/** How often `sync.tick` starts each stream per Channel. `order_status_push` only runs on demand. */
export const SYNC_INTERVALS_MS = { offers_pull: 3_600_000, orders_pull: 120_000, stock_push: 600_000 } as const

export type ScheduledStream = keyof typeof SYNC_INTERVALS_MS

const SCHEDULED_STREAMS = Object.keys(SYNC_INTERVALS_MS) as ScheduledStream[]

/** Streams never started, or last started longer ago than their interval. */
export function dueStreams(lastStartedAt: Partial<Record<SyncStream, Date>>, now: Date): ScheduledStream[] {
  return SCHEDULED_STREAMS.filter((stream) => {
    const last = lastStartedAt[stream]
    return last === undefined || now.getTime() - last.getTime() >= SYNC_INTERVALS_MS[stream]
  })
}
