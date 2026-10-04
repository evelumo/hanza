import { describe, expect, it } from 'vitest'
import { dueStreams, SYNC_INTERVALS_MS } from './schedule'

describe('dueStreams', () => {
  const now = new Date('2026-10-04T12:00:00Z')
  const ago = (ms: number) => new Date(now.getTime() - ms)

  it('every stream is due when none ever started', () => {
    expect(dueStreams({}, now)).toEqual(['offers_pull', 'orders_pull', 'stock_push'])
  })

  it('a stream is due once its interval has passed since its last start', () => {
    expect(
      dueStreams(
        {
          offers_pull: ago(SYNC_INTERVALS_MS.offers_pull - 1),
          orders_pull: ago(SYNC_INTERVALS_MS.orders_pull),
          stock_push: ago(60_000),
          order_status_push: ago(10 * SYNC_INTERVALS_MS.offers_pull),
        },
        now,
      ),
    ).toEqual(['orders_pull'])
  })
})
