import { describe, expect, it } from 'vitest'
import { dueStreams, SYNC_INTERVALS_MS, TICK_EVERY_MS } from './schedule'

describe('dueStreams', () => {
  const now = new Date('2026-10-04T12:00:00Z')
  const ago = (ms: number) => new Date(now.getTime() - ms)

  it('every stream is due when none ever started', () => {
    expect(dueStreams({}, now)).toEqual(['offers_pull', 'orders_pull', 'stock_push', 'price_push'])
  })

  it('a stream is due once its interval, less half a tick, has passed since its last start', () => {
    expect(
      dueStreams(
        {
          offers_pull: ago(SYNC_INTERVALS_MS.offers_pull - TICK_EVERY_MS / 2 - 1),
          orders_pull: ago(SYNC_INTERVALS_MS.orders_pull - TICK_EVERY_MS / 2),
          stock_push: ago(60_000),
          price_push: ago(SYNC_INTERVALS_MS.price_push - TICK_EVERY_MS),
          order_status_push: ago(10 * SYNC_INTERVALS_MS.offers_pull),
        },
        now,
      ),
    ).toEqual(['orders_pull'])
  })

  it('a run started just after the tick that enqueued it is due again at the tick one interval later', () => {
    const tick = new Date('2026-10-04T12:00:00Z').getTime()
    const startedAt = new Date(tick + 150)
    expect(dueStreams({ orders_pull: startedAt }, new Date(tick + 60_000))).not.toContain('orders_pull')
    expect(dueStreams({ orders_pull: startedAt }, new Date(tick + SYNC_INTERVALS_MS.orders_pull))).toContain('orders_pull')
  })
})
