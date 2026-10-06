import type { CapabilityName } from '@hanza/connector-sdk'
import type { SyncStream } from '@hanza/db'

export const TICK_EVERY_MS = 60_000

/** How often `sync.tick` starts each stream per Channel. `order_status_push` runs per Order: on demand, and from the tick's sweep of pending pushes. */
export const SYNC_INTERVALS_MS = { offers_pull: 3_600_000, orders_pull: 120_000, stock_push: 600_000, price_push: 600_000 } as const

export type ScheduledStream = keyof typeof SYNC_INTERVALS_MS

/** The capability each scheduled stream runs; the tick skips a stream whose connector lacks it (`price.push` is optional). */
export const STREAM_CAPABILITIES: Record<ScheduledStream, CapabilityName> = {
  offers_pull: 'offers.pull',
  orders_pull: 'orders.pull',
  stock_push: 'stock.push',
  price_push: 'price.push',
}

const SCHEDULED_STREAMS = Object.keys(SYNC_INTERVALS_MS) as ScheduledStream[]

// A run starts a little after the tick that enqueued it, so without slack a stream would
// miss the tick exactly one interval later and run every interval + one tick.
const SLACK_MS = TICK_EVERY_MS / 2

/** Streams never started, or last started at least their interval (less half a tick) ago. */
export function dueStreams(lastStartedAt: Partial<Record<SyncStream, Date>>, now: Date): ScheduledStream[] {
  return SCHEDULED_STREAMS.filter((stream) => {
    const last = lastStartedAt[stream]
    return last === undefined || now.getTime() - last.getTime() >= SYNC_INTERVALS_MS[stream] - SLACK_MS
  })
}
