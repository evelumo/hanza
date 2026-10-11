import { classifyConnectorError, isCursorExpiredError, isOrderUpdate, orderSchema, orderUpdateSchema, type Order, type OrderFeedItem, type OrderUpdate } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { WOO_ORDER_FIELDS } from '../api'
import { replayConfig, replayCredentials } from '../testing/recording'
import { rawLine, rawOrder } from '../testing/samples'
import type { WooCommerceContext } from '../settings'
import { FakeShop } from '../testing/orders-fake-shop'
import { CLOCK_SKEW_ALLOWANCE_SECONDS, dateFilter, pullOrders, type OrdersPullOptions } from './orders-pull'
import { MAX_RUN_REQUESTS } from './orders-stream'

// The feed against a WooCommerce in memory (`testing/orders-fake-shop.ts`), which can change between two requests. What the
// real shop answers is in `orders-pull.recorded.test.ts`.

const HOLD_BACK = 20
const FIELDS = WOO_ORDER_FIELDS.join(',')
const NO_DATE_LOG = { message: `WooCommerce sent no Date header: Hanza's own clock is used, ${CLOCK_SKEW_ALLOWANCE_SECONDS} s further behind` }
const unpaid = { date_paid_gmt: null }

// With a `Date` header on every answer nothing may depend on Hanza's clock: a recorded cassette would not replay.
const noHanzaClock = (): number => {
  throw new Error('the feed read Hanza\'s clock although the shop sent its own')
}

function pull(shop: FakeShop, cursor: string | null, options: Partial<OrdersPullOptions> = {}) {
  return pullOrders(shop.context(), cursor, { pageSize: 3, holdBackSeconds: HOLD_BACK, now: noHanzaClock, ...options })
}

const label = (item: OrderFeedItem) => (isOrderUpdate(item) ? `update ${item.externalId}` : `order ${item.externalId}`)
const labels = (items: OrderFeedItem[]) => items.map(label)
const factTypes = (item: OrderFeedItem) => item.facts.map((fact) => fact.type)

/** One Connection's feed, polled as the engine does: every page until `hasMore` is false, from the saved cursor. */
class Feed {
  cursor: string | null = null
  /** Requests of each call, to see that none makes more than a few. */
  readonly requestsPerCall: number[] = []

  constructor(
    private readonly shop: FakeShop,
    private readonly options: Partial<OrdersPullOptions> = {},
  ) {}

  /** One call. */
  async page(): Promise<{ items: OrderFeedItem[]; hasMore: boolean }> {
    const before = this.shop.requests.length
    const result = await pull(this.shop, this.cursor, this.options)
    this.requestsPerCall.push(this.shop.requests.length - before)
    for (const item of result.items) expect((isOrderUpdate(item) ? orderUpdateSchema : orderSchema).safeParse(item).success, label(item)).toBe(true)
    if (result.hasMore) expect(result.nextCursor, 'hasMore with an unchanged cursor').not.toBe(this.cursor)
    this.cursor = result.nextCursor
    return result
  }

  async poll(): Promise<OrderFeedItem[]> {
    const items: OrderFeedItem[] = []
    for (let pages = 0; pages < 200; pages++) {
      const result = await this.page()
      items.push(...result.items)
      if (!result.hasMore) return items
    }
    throw new Error('the feed never ended')
  }

  /** The start and the whole listing, stopping before the first read of the changes. */
  async list(): Promise<OrderFeedItem[]> {
    const items: OrderFeedItem[] = []
    while (this.cursor === null || this.cursor.startsWith('l1:')) items.push(...(await this.page()).items)
    return items
  }
}

/** A shop with orders from before the Connection, a day old by the time the feed starts. */
function shopWith(orders: Array<Record<string, unknown>>): FakeShop {
  const shop = new FakeShop('2026-10-01T08:00:00Z')
  for (const order of orders) {
    shop.place(order)
    shop.tick(60)
  }
  shop.nowMs = Date.parse('2026-10-10T12:00:00Z')
  return shop
}

/** Lets the hold-back pass, so everything saved so far can be read. */
const settle = (shop: FakeShop) => shop.tick(HOLD_BACK + 1)

describe('dateFilter', () => {
  it('is UTC in whole seconds with a literal Z', () => {
    expect(dateFilter(Date.parse('2026-10-10T18:51:38Z') / 1000)).toBe('2026-10-10T18:51:38Z')
    // Not `toISOString()`: WooCommerce reads a value with a fraction as site time.
    expect(dateFilter(1_791_658_298)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })
})

describe('the start (cursor null)', () => {
  it('takes the shop\'s clock less the hold-back, then the highest order id, and reports nothing yet', async () => {
    const shop = shopWith([{}, {}, {}])
    const result = await pull(shop, null)
    expect(result).toEqual({ items: [], nextCursor: `l1:${shop.second - HOLD_BACK}:3:0:0:0`, hasMore: true })
    expect(shop.urls).toEqual([
      'GET orders?status=any&orderby=id&order=desc&per_page=1&_fields=id',
      'GET orders?status=trash&orderby=id&order=desc&per_page=1&_fields=id',
    ])
  })

  it('counts an order in the trash for the boundary', async () => {
    const shop = shopWith([{}, {}, {}])
    shop.trash(3)
    expect((await pull(shop, null)).nextCursor).toBe(`l1:${shop.second - HOLD_BACK}:3:0:0:0`)
  })

  it('reads the clock from the first answer, before the boundary is known', async () => {
    const shop = shopWith([{}])
    const startSecond = shop.second
    // The shop is slow, and an order is placed before it answers the second request.
    shop.beforeAnswer = (count) => {
      if (count === 2) shop.tick(5).place()
    }
    expect((await pull(shop, null)).nextCursor).toBe(`l1:${startSecond - HOLD_BACK}:1:0:0:0`)
  })

  it('without a Date header uses Hanza\'s clock, set back by the skew allowance, and says so once', async () => {
    const shop = shopWith([{}])
    shop.sendsDate = false
    const result = await pull(shop, null, { now: () => Date.parse('2026-10-10T12:00:07.900Z') })
    // Hanza's clock may be ahead of the shop's: the changes then start two minutes earlier rather than too late.
    expect(result.nextCursor).toBe(`l1:${Date.parse('2026-10-10T12:00:07Z') / 1000 - CLOCK_SKEW_ALLOWANCE_SECONDS - HOLD_BACK}:1:0:0:0`)
    expect(shop.logs).toEqual([NO_DATE_LOG])
  })

  it('a shop with no orders at all: boundary 0, an empty listing, then the first order ever in full', async () => {
    const shop = new FakeShop()
    const feed = new Feed(shop)
    expect(await feed.poll()).toEqual([])
    expect(feed.cursor).toBe(`c1:${shop.second - HOLD_BACK}:0:${shop.second - HOLD_BACK}:0:0:0`)

    const first = shop.place()
    settle(shop)
    expect(labels(await feed.poll())).toEqual([`order ${first}`])
  })
})

describe('the listing', () => {
  it('lists the open orders by creation time and id, a page per call, then hands over to the changes', async () => {
    const shop = shopWith([{ status: 'processing' }, { status: 'on-hold', ...unpaid }, { status: 'completed' }, { status: 'pending', ...unpaid }, { status: 'cancelled' }, {}, {}])
    const feed = new Feed(shop)
    const start = shop.second - HOLD_BACK

    await feed.page()
    expect(labels((await feed.page()).items)).toEqual(['order 1', 'order 2', 'order 4'])
    expect(labels((await feed.page()).items)).toEqual(['order 6', 'order 7'])
    // That page was full (the anchor and two more), so one more call finds the end of the list.
    expect(await feed.page()).toMatchObject({ items: [], hasMore: true })
    // The changes begin at the start that was taken before the listing, not at the time the listing ended.
    expect(feed.cursor).toBe(`c1:${start}:7:${start}:0:0:0`)
    expect(await feed.page()).toEqual({ items: [], nextCursor: feed.cursor, hasMore: false })

    expect(shop.urls.slice(2, 4)).toEqual([
      `GET orders?status=pending,on-hold,processing&orderby=date&per_page=3&order=asc&_fields=${FIELDS}`,
      // Order 4 was created at 08:03:00: its second is read again, and it comes back first and is dropped.
      `GET orders?status=pending,on-hold,processing&orderby=date&per_page=3&after=2026-10-01T08:02:59Z&order=asc&_fields=${FIELDS}`,
    ])
  })

  it('orders by creation time before id', async () => {
    // The highest id is the oldest order, as when a checkout stayed open for a day.
    const shop = shopWith([{}, {}, { date_created_gmt: '2026-09-30T06:00:00' }])
    expect(labels(await new Feed(shop).list())).toEqual(['order 3', 'order 1', 'order 2'])
  })

  it('does not import an order that was completed once and reopened: it is closed, whatever its status says', async () => {
    const shop = shopWith([{}, { status: 'processing', date_completed_gmt: '2026-09-30T10:00:00' }, {}])
    expect(labels(await new Feed(shop).list())).toEqual(['order 1', 'order 3'])
  })

  it('lists more orders of one second than fit a page, each once', async () => {
    const sameSecond = { date_created_gmt: '2026-09-30T06:00:00' }
    const shop = shopWith([{}, sameSecond, sameSecond, sameSecond, sameSecond, sameSecond, sameSecond, sameSecond, {}])
    const feed = new Feed(shop)
    expect(labels(await feed.list())).toEqual(['order 2', 'order 3', 'order 4', 'order 5', 'order 6', 'order 7', 'order 8', 'order 1', 'order 9'])
    expect(shop.urls[3]).toBe(`GET orders?status=pending,on-hold,processing&orderby=date&per_page=3&after=2026-09-30T05:59:59Z&offset=2&order=asc&_fields=${FIELDS}`)
    // The start is two requests; every page of the listing is one (no line is a variation, so no look at parents).
    expect(feed.requestsPerCall).toEqual([2, 1, 1, 1, 1, 1])
  })

  it('an order that closes between two pages makes no other order skipped', async () => {
    const shop = shopWith([{}, {}, {}, {}, {}, {}, {}])
    const feed = new Feed(shop)
    await feed.page()
    expect(labels((await feed.page()).items)).toEqual(['order 1', 'order 2', 'order 3'])
    // One that was listed closes, and one that was not: by offset, order 4 would now be skipped.
    shop.cancel(2).complete(6)
    const rest = await feed.list()
    expect(labels(rest)).toEqual(['order 4', 'order 5', 'order 7'])

    // What closed arrives as facts: applied to the Order that was imported, ignored for the one that never was.
    settle(shop)
    const after = await feed.poll()
    expect(labels(after)).toEqual(['update 2', 'update 6'])
    expect(after.map(factTypes)).toEqual([['paid', 'cancelled'], ['paid', 'shipped']])
  })

  it('an order of the same second that closes between two pages makes no other order skipped either', async () => {
    const sameSecond = { date_created_gmt: '2026-09-30T06:00:00' }
    const shop = shopWith([sameSecond, sameSecond, sameSecond, sameSecond, sameSecond, sameSecond, sameSecond])
    const feed = new Feed(shop)
    await feed.page()
    expect(labels((await feed.page()).items)).toEqual(['order 1', 'order 2', 'order 3'])
    // The page behind rank 3 now starts at order 5: without the anchor, order 4 would never reserve.
    shop.cancel(1)
    expect(labels(await feed.list())).toEqual(['order 4', 'order 5', 'order 6', 'order 7'])
  })

  it('an order placed while the listing runs is reported in full: at the end of the listing, and again with the changes', async () => {
    const shop = shopWith([{}, {}, {}, {}])
    const feed = new Feed(shop)
    await feed.page()
    await feed.page()
    const placed = shop.tick(2).place({ status: 'on-hold', ...unpaid })
    expect(labels(await feed.list())).toEqual(['order 4', `order ${placed}`])

    settle(shop)
    const again = await feed.poll()
    expect(labels(again)).toEqual([`order ${placed}`])
    expect(again[0]).toMatchObject({ awaitingPayment: true, facts: [] })
  })

  it('an order placed between the start and its second request is above no boundary it should be below', async () => {
    const shop = shopWith([{}])
    const feed = new Feed(shop)
    let placed = 0
    shop.beforeAnswer = (count) => {
      if (count === 2) placed = shop.place()
    }
    // Not counted for the boundary (the first answer did not have it), so it is "after": in full with the changes too.
    expect(labels(await feed.list())).toEqual(['order 1', `order ${placed}`])
    shop.beforeAnswer = null
    settle(shop)
    expect(labels(await feed.poll())).toEqual([`order ${placed}`])
  })

  describe('an order in a status a plugin added', () => {
    // The listing asks for WooCommerce's own three open statuses and no other: a plugin's status may as well be one
    // for orders that are done (`delivered`), and listing those would reserve Stock for everything a shop ever shipped.
    it('is not listed at the start, whatever else is', async () => {
      const shop = shopWith([{}, { status: 'packing' }, { status: 'packing', ...unpaid }, { status: 'on-hold', ...unpaid }])
      const feed = new Feed(shop)
      expect(labels(await feed.list())).toEqual(['order 1', 'order 4'])
      // Three statuses, the same on every shop: none that a shop may not have, and no request to find out more.
      expect(shop.urls.slice(2)).toEqual([`GET orders?status=pending,on-hold,processing&orderby=date&per_page=3&order=asc&_fields=${FIELDS}`])
      expect(shop.logs).toEqual([])
    })

    it('is imported in full when it next changes while still open', async () => {
      const shop = shopWith([{}, { status: 'packing' }])
      const feed = new Feed(shop)
      await feed.poll()
      // A note, a payment, a move to another open status: anything that saves the order.
      shop.tick(60).save(2)
      settle(shop)
      const items = await feed.poll()
      expect(labels(items)).toEqual(['order 2'])
      expect(factTypes(items[0]!)).toEqual(['paid'])
    })

    it('THE GAP: when its next change is its completion, it is never imported, and its units stay in Stock', async () => {
      const shop = shopWith([{}, { status: 'packing' }])
      const feed = new Feed(shop)
      const everything: OrderFeedItem[] = await feed.poll()

      shop.tick(60).complete(2)
      settle(shop)
      everything.push(...(await feed.poll()))
      // Later changes do not help either: it is closed, and from before the boundary.
      shop.tick(60).save(2)
      settle(shop)
      everything.push(...(await feed.poll()))

      // Only its facts ever arrive, as updates for an Order Hanza does not have, which the core ignores: nothing
      // reserves for it and nothing takes its units off Stock, though they left the shelf.
      const about = everything.filter((item) => item.externalId === '2')
      expect(labels(about)).toEqual(['update 2', 'update 2'])
      expect(about.map(factTypes)).toEqual([['paid', 'shipped'], ['paid', 'shipped']])
    })
  })

  it('an order dated before 1970 is listed like any other, and the feed goes on', async () => {
    const shop = shopWith([{ date_created_gmt: '1969-12-31T23:00:00' }, { date_created_gmt: '1969-12-31T22:00:00' }, { date_created_gmt: '0001-01-01T00:00:00' }, {}, {}])
    const feed = new Feed(shop)
    const pages: string[][] = []
    while (feed.cursor === null || feed.cursor.startsWith('l1:')) pages.push(labels((await feed.page()).items))
    expect(pages.flat()).toEqual(['order 3', 'order 2', 'order 1', 'order 4', 'order 5'])
    // The position before 1970 went through the cursor and back.
    expect(shop.urls.some((url) => url.includes('after=1969-12-31T22:59:59Z'))).toBe(true)
    expect(await feed.poll()).toEqual([])
  })

  it('skips an open order that does not fit the canonical Order, naming it and the paths only', async () => {
    const shop = shopWith([{}, { line_items: [] }, {}])
    expect(labels(await new Feed(shop).list())).toEqual(['order 1', 'order 3'])
    expect(shop.logs).toEqual([{ message: 'WooCommerce order skipped: it does not fit the canonical Order', fields: { orderId: 2, problems: ['lines'] } }])
    expect(JSON.stringify(shop.logs)).not.toMatch(/Ewa|Fikcyjna|example\.test|Wrocław/)
  })

  it('goes on with an empty page when a whole page was skipped', async () => {
    const shop = shopWith([{ line_items: [] }, { line_items: [] }, { line_items: [] }, {}])
    const feed = new Feed(shop)
    await feed.page()
    const first = await feed.page()
    expect(first.items).toEqual([])
    expect(first.hasMore).toBe(true)
    expect(labels(await feed.list())).toEqual(['order 4'])
  })
})

describe('the changes', () => {
  /** A feed past its listing, with nothing left to read. */
  async function connected(shop: FakeShop, options: Partial<OrdersPullOptions> = {}): Promise<Feed> {
    const feed = new Feed(shop, options)
    await feed.poll()
    shop.requests.length = 0
    shop.logs.length = 0
    return feed
  }

  it('asks for what was modified after the position, live orders and trash, in UTC seconds without dates_are_gmt', async () => {
    const shop = shopWith([{}])
    const feed = await connected(shop)
    const start = shop.second - HOLD_BACK
    expect(await feed.page()).toEqual({ items: [], nextCursor: `c1:${start}:1:${start}:0:0:0`, hasMore: false })
    // 12:00:00 less the hold-back is 11:59:40; the filter is strict, so the second before it is asked for.
    expect(shop.urls).toEqual([
      `GET orders?status=any&orderby=modified&per_page=3&modified_after=2026-10-10T11:59:39Z&order=asc&_fields=${FIELDS}`,
      `GET orders?status=trash&orderby=modified&per_page=3&modified_after=2026-10-10T11:59:39Z&order=asc&_fields=${FIELDS}`,
    ])
  })

  it('with nothing new returns no items, the cursor it was given, and hasMore false', async () => {
    const shop = shopWith([{}, {}])
    const feed = await connected(shop)
    const cursor = feed.cursor
    for (const seconds of [0, 1, 30, 3600]) {
      shop.tick(seconds)
      expect(await pull(shop, cursor)).toEqual({ items: [], nextCursor: cursor, hasMore: false })
    }
  })

  it('gives the same page for the same cursor', async () => {
    const shop = shopWith([{}, {}, {}, {}])
    const feed = await connected(shop)
    shop.tick(5)
    shop.cancel(1).pay(2)
    shop.tick(1).complete(3).trash(4)
    settle(shop)
    const cursor = feed.cursor
    const first = await pull(shop, cursor, { pageSize: 10 })
    expect(labels(first.items)).toEqual(['update 1', 'order 2', 'update 3', 'update 4'])
    expect(await pull(shop, cursor, { pageSize: 10 })).toEqual(first)
  })

  describe('the hold-back', () => {
    it('reads a second only once it ended the hold-back ago', async () => {
      const shop = shopWith([{}])
      const feed = await connected(shop)
      shop.tick(100).cancel(1)
      const saved = shop.second
      for (const later of [0, 1, HOLD_BACK - 1, HOLD_BACK]) {
        shop.nowMs = (saved + later) * 1000
        expect(await feed.poll(), `${later} s after the save`).toEqual([])
      }
      shop.nowMs = (saved + HOLD_BACK + 1) * 1000
      expect(labels(await feed.poll())).toEqual(['update 1'])
    })

    it('with a hold-back of 0 still waits for the second to end', async () => {
      const shop = shopWith([{}])
      const feed = await connected(shop, { holdBackSeconds: 0 })
      shop.tick(100).cancel(1)
      expect(await feed.poll()).toEqual([])
      shop.tick(1)
      expect(labels(await feed.poll())).toEqual(['update 1'])
    })

    it('two saves of one order within one second arrive as one snapshot, the later one', async () => {
      const shop = shopWith([])
      const feed = await connected(shop)
      shop.tick(100)
      const order = shop.place({ status: 'on-hold', payment_method: 'bacs', ...unpaid })
      // Polled between the two saves: the first state must not be taken, or the second would hide behind the cursor.
      expect(await feed.poll()).toEqual([])
      shop.pay(order)
      expect(await feed.poll()).toEqual([])
      settle(shop)
      const items = await feed.poll()
      expect(labels(items)).toEqual([`order ${order}`])
      expect(items[0]).not.toHaveProperty('awaitingPayment')
      expect(factTypes(items[0]!)).toEqual(['paid'])
    })

    it('a lower id saved later in the same second is not hidden behind a higher one', async () => {
      const shop = shopWith([{}, {}, {}])
      const feed = await connected(shop)
      shop.tick(100).cancel(3)
      expect(await feed.poll()).toEqual([])
      shop.cancel(1)
      settle(shop)
      expect(labels(await feed.poll())).toEqual(['update 1', 'update 3'])
    })

    it('uses the earlier clock of its two requests', async () => {
      const shop = shopWith([{}])
      const feed = await connected(shop)
      shop.tick(100).cancel(1)
      // At the first request the save is 20 s old, not yet readable; the shop then takes two seconds to answer.
      shop.tick(HOLD_BACK)
      shop.beforeAnswer = (count) => {
        if (count === 2) shop.tick(2)
      }
      expect(await feed.poll()).toEqual([])
    })

    it('without a Date header reads by Hanza\'s clock set back by the skew allowance, and says so once per call', async () => {
      const shop = shopWith([{}])
      const feed = await connected(shop)
      shop.tick(100).cancel(1)
      const saved = shop.second
      shop.sendsDate = false
      const at = (seconds: number) => ({ now: () => (saved + seconds) * 1000 + 999 })
      // What would be readable by the shop's own clock is not yet: Hanza's may be ahead by up to the allowance.
      for (const later of [HOLD_BACK + 1, 60, CLOCK_SKEW_ALLOWANCE_SECONDS + HOLD_BACK]) {
        expect((await pull(shop, feed.cursor, at(later))).items, `${later} s after the save`).toEqual([])
      }
      shop.logs.length = 0
      expect(labels((await pull(shop, feed.cursor, at(CLOCK_SKEW_ALLOWANCE_SECONDS + HOLD_BACK + 1))).items)).toEqual(['update 1'])
      // Two requests without the header, one line.
      expect(shop.logs).toEqual([NO_DATE_LOG])
    })

    it('a second save in a second Hanza\'s fast clock took for over is not lost', async () => {
      const shop = shopWith([{}, {}])
      const feed = await connected(shop)
      shop.sendsDate = false
      // Hanza's clock runs 90 s ahead of the shop's.
      const ahead = { now: () => shop.nowMs + 90_000 }
      shop.tick(100).cancel(2)
      // By Hanza's clock that second ended 90 s ago; in the shop it is still running.
      expect((await pull(shop, feed.cursor, ahead)).items).toEqual([])
      shop.cancel(1)
      shop.tick(CLOCK_SKEW_ALLOWANCE_SECONDS)
      const items = (await pull(shop, feed.cursor, ahead)).items
      expect(labels(items)).toEqual(['update 1', 'update 2'])
    })

    it('with the header on one answer and not on the other, takes the more careful clock', async () => {
      const shop = shopWith([{}])
      const feed = await connected(shop)
      shop.tick(100).cancel(1)
      shop.tick(HOLD_BACK + 1)
      // The second answer (the trash) comes without the header; Hanza's clock agrees with the shop's.
      shop.beforeAnswer = (count) => {
        shop.sendsDate = count !== 2
      }
      expect((await pull(shop, feed.cursor, { now: () => shop.nowMs })).items).toEqual([])
      expect(shop.logs).toEqual([NO_DATE_LOG])
    })
  })

  describe('paging', () => {
    it('pages by modification time and id, and goes on while there is more', async () => {
      const shop = shopWith([{}, {}, {}, {}, {}, {}, {}])
      const feed = await connected(shop)
      for (const id of [5, 2, 7, 1, 4, 3, 6]) shop.tick(1).save(id)
      settle(shop)
      const first = await feed.page()
      // The page held three; its last second may go on behind it, so that one is left for the next call.
      expect(labels(first.items)).toEqual(['order 5', 'order 2'])
      expect(first.hasMore).toBe(true)
      expect(labels(await feed.poll())).toEqual(['order 7', 'order 1', 'order 4', 'order 3', 'order 6'])
      expect(Math.max(...feed.requestsPerCall)).toBeLessThanOrEqual(2 * MAX_RUN_REQUESTS)
    })

    it('an order modified again while the changes are paged leaves its place without another order being skipped', async () => {
      const shop = shopWith([{}, {}, {}, {}, {}, {}])
      const feed = await connected(shop)
      for (const id of [1, 2, 3, 4, 5, 6]) shop.tick(1).save(id)
      settle(shop)
      expect(labels((await feed.page()).items)).toEqual(['order 1', 'order 2'])
      // The last one reported (which the next request expects back first), the one the page gave up, and one not
      // read yet are all saved again.
      shop.cancel(2).save(3).cancel(5)
      expect(labels(await feed.poll())).toEqual(['order 4', 'order 6'])
      settle(shop)
      const later = await feed.poll()
      expect(labels(later)).toEqual(['update 2', 'order 3', 'update 5'])
    })

    it('reads more changes of one second than fit a page, each once', async () => {
      const shop = shopWith(Array.from({ length: 9 }, () => ({})))
      const feed = await connected(shop)
      // A bulk action: every order saved in the same second.
      shop.tick(100)
      for (let id = 9; id >= 1; id--) shop.save(id)
      settle(shop)
      expect(labels(await feed.poll())).toEqual(Array.from({ length: 9 }, (_, index) => `order ${index + 1}`))
      expect(Math.max(...feed.requestsPerCall)).toBeLessThanOrEqual(2 * MAX_RUN_REQUESTS)
      // That second is asked for alone, between the second before it and the one after, in the order of its ids.
      const at = new Date(shop.nowMs - (HOLD_BACK + 1) * 1000)
      const [before, after] = [-1, 1].map((seconds) => dateFilter(at.getTime() / 1000 + seconds))
      expect(shop.urls.filter((url) => url.includes('orderby=id')).slice(0, 4)).toEqual([
        `GET orders?status=any&orderby=id&per_page=3&modified_after=${before}&modified_before=${after}&order=asc&_fields=${FIELDS}`,
        `GET orders?status=trash&orderby=id&per_page=3&modified_after=${before}&modified_before=${after}&order=asc&_fields=${FIELDS}`,
        `GET orders?status=any&orderby=id&per_page=3&modified_after=${before}&modified_before=${after}&offset=2&order=asc&_fields=${FIELDS}`,
        `GET orders?status=trash&orderby=id&per_page=3&modified_after=${before}&modified_before=${after}&order=asc&_fields=${FIELDS}`,
      ])
      // Afterwards the changes go on from the next second, with the plain request.
      expect(feed.cursor).toBe(`c1:${shop.second - 2 * HOLD_BACK - 100 - 1}:9:${at.getTime() / 1000 + 1}:0:0:0`)
    })

    it('in such a second, an order saved again between two pages makes no other order skipped', async () => {
      const shop = shopWith(Array.from({ length: 9 }, () => ({})))
      const feed = await connected(shop)
      shop.tick(100)
      for (let id = 1; id <= 9; id++) shop.save(id)
      settle(shop)
      // The first call finds a page that lies inside one second, and turns to that second alone, by id.
      expect(await feed.page()).toMatchObject({ items: [], hasMore: true, nextCursor: expect.stringMatching(/^s1:\d+:9:\d+:0:0:0$/) })
      expect(labels((await feed.page()).items)).toEqual(['order 1', 'order 2', 'order 3'])
      expect(feed.cursor).toMatch(/^s1:\d+:9:\d+:3:3:0$/)
      shop.cancel(1).cancel(2)
      const rest = await feed.poll()
      expect(labels(rest)).toEqual(['order 4', 'order 5', 'order 6', 'order 7', 'order 8', 'order 9'])
      settle(shop)
      expect(labels(await feed.poll())).toEqual(['update 1', 'update 2'])
    })

    it('merges the trash into the live orders by time, and holds it back while the live list has more pages', async () => {
      const shop = shopWith([{}, {}, {}, {}, {}, {}])
      const feed = await connected(shop)
      shop.tick(1).save(1)
      shop.tick(1).trash(2)
      shop.tick(1).save(3)
      shop.tick(1).save(4)
      shop.tick(1).save(5)
      shop.tick(1).trash(6)
      settle(shop)
      const first = await feed.page()
      // The live list is whole up to order 3 (the page ended on 4, whose second may go on); order 6 in the trash
      // is later than that, so it waits.
      expect(labels(first.items)).toEqual(['order 1', 'update 2', 'order 3'])
      expect(first.hasMore).toBe(true)
      expect(labels(await feed.poll())).toEqual(['order 4', 'order 5', 'update 6'])
    })

    it('never makes more than a few requests in one call', async () => {
      const shop = shopWith(Array.from({ length: 30 }, () => ({})))
      const feed = new Feed(shop)
      await feed.poll()
      shop.tick(100)
      for (let id = 1; id <= 30; id++) shop.save(id)
      settle(shop)
      await feed.page()
      for (let id = 1; id <= 30; id += 4) shop.trash(id)
      await feed.poll()
      // Two lists, each within its budget, and one look at the parents of variation lines.
      expect(Math.max(...feed.requestsPerCall)).toBeLessThanOrEqual(2 * MAX_RUN_REQUESTS + 1)
    })
  })

  describe('a full Order or an Order update', () => {
    // Orders 1 to 4 are from before the boundary (4); what is placed later is after it.
    async function shopAndFeed() {
      const shop = shopWith([{}, {}, { status: 'cancelled' }, { status: 'completed', date_completed_gmt: '2026-10-01T09:00:00' }])
      return { shop, feed: await connected(shop) }
    }

    it('after the boundary and open: a full Order', async () => {
      const { shop, feed } = await shopAndFeed()
      const placed = shop.tick(60).place()
      settle(shop)
      const items = await feed.poll()
      expect(labels(items)).toEqual([`order ${placed}`])
      expect(factTypes(items[0]!)).toEqual(['paid'])
    })

    it('after the boundary and closed: a full Order with every fact, so what was sold after the Connection is taken off Stock', async () => {
      const { shop, feed } = await shopAndFeed()
      const shipped = shop.tick(60).place()
      const cancelled = shop.place({ status: 'pending', ...unpaid })
      shop.tick(5).complete(shipped).cancel(cancelled)
      settle(shop)
      const items = await feed.poll()
      expect(labels(items)).toEqual([`order ${shipped}`, `order ${cancelled}`])
      expect(items.map(factTypes)).toEqual([['paid', 'shipped'], ['cancelled']])
    })

    it('before the boundary and open: a full Order', async () => {
      const { shop, feed } = await shopAndFeed()
      shop.tick(60).save(1)
      settle(shop)
      expect(labels(await feed.poll())).toEqual(['order 1'])
    })

    it('before the boundary and closed: an Order update with its facts, never a full Order', async () => {
      const { shop, feed } = await shopAndFeed()
      shop.tick(60).complete(1).cancel(2)
      // An order closed before the Connection that is touched again (a note, a refund) must not be imported.
      shop.save(3).save(4)
      settle(shop)
      const items = await feed.poll()
      expect(labels(items)).toEqual(['update 1', 'update 2', 'update 3', 'update 4'])
      expect(items.map(factTypes)).toEqual([['paid', 'shipped'], ['paid', 'cancelled'], ['paid', 'cancelled'], ['paid', 'shipped']])
      for (const item of items) expect(Object.keys(item).sort()).toEqual(['externalId', 'facts', 'kind'])
    })

    it('closed and not fitting the canonical Order: an Order update, on either side of the boundary', async () => {
      const { shop, feed } = await shopAndFeed()
      const placed = shop.tick(60).place({ line_items: [] })
      shop.save(1, { line_items: [] })
      shop.tick(5).cancel(1).cancel(placed)
      settle(shop)
      expect(labels(await feed.poll())).toEqual(['update 1', `update ${placed}`])
      expect(shop.logs).toEqual([])
    })

    it('open and not fitting the canonical Order: skipped and logged, and the page goes on', async () => {
      const { shop, feed } = await shopAndFeed()
      shop.tick(60)
      const noLines = shop.place({ line_items: [] })
      const half = shop.place({ line_items: [rawLine(0, { quantity: 0.5 })] })
      const fine = shop.place()
      shop.save(1, { billing: { ...(rawOrder().billing as object), country: '' }, shipping: { ...(rawOrder().shipping as object), country: '' } })
      settle(shop)
      expect(labels(await feed.poll())).toEqual([`order ${fine}`])
      // All saved in one second, so in the order of their ids.
      expect(shop.logs.map(({ fields }) => fields)).toEqual([
        { orderId: 1, problems: ['shippingAddress'] },
        { orderId: noLines, problems: ['lines'] },
        { orderId: half, problems: ['lines.0.quantity', 'lines.0.unitPrice.amount'] },
      ])
      // The cursor moved past them: they are not read again on every poll.
      shop.logs.length = 0
      settle(shop)
      expect(await feed.poll()).toEqual([])
      expect(shop.logs).toEqual([])
    })

    it('never reports a checkout that was not placed, should a shop list one', async () => {
      const { shop, feed } = await shopAndFeed()
      const draft = shop.tick(60).place({ status: 'checkout-draft', ...unpaid })
      settle(shop)
      // `status=any` leaves it out, as on the real shop.
      expect(await feed.poll()).toEqual([])
      // Placed: now it is an order, with an id above the boundary although its checkout began earlier.
      shop.save(draft, { status: 'on-hold' })
      settle(shop)
      expect(labels(await feed.poll())).toEqual([`order ${draft}`])
    })
  })

  describe('what happens to an order', () => {
    async function shopAndFeed(orders: Array<Record<string, unknown>> = [{}, {}]) {
      const shop = shopWith(orders)
      return { shop, feed: await connected(shop) }
    }

    it('trashed after it was imported: a cancelled fact, as an update before the boundary and a full Order after it', async () => {
      const { shop, feed } = await shopAndFeed()
      const placed = shop.tick(60).place()
      settle(shop)
      expect(labels(await feed.poll())).toEqual([`order ${placed}`])

      shop.trash(1).trash(placed)
      settle(shop)
      const items = await feed.poll()
      expect(labels(items)).toEqual(['update 1', `order ${placed}`])
      expect(items[0]!.facts.at(-1)).toMatchObject({ id: '1:cancelled', type: 'cancelled', note: 'WooCommerce status: trash' })
      expect(items[1]!.facts.at(-1)).toMatchObject({ id: `${placed}:cancelled`, type: 'cancelled' })
    })

    it.each(['on-hold', 'pending'])('unpaid (%s) and then paid: awaiting payment first, later a paid fact, never the flag dropped without it', async (status) => {
      const { shop, feed } = await shopAndFeed()
      const order = shop.tick(60).place({ status, payment_method: 'bacs', ...unpaid })
      settle(shop)
      const before = await feed.poll()
      expect(before).toMatchObject([{ externalId: String(order), payment: 'prepaid', awaitingPayment: true, facts: [] }])

      // Touched while still unpaid: awaiting payment again, not "ready".
      shop.save(order)
      settle(shop)
      expect(await feed.poll()).toMatchObject([{ awaitingPayment: true, facts: [] }])

      shop.pay(order)
      const paidAt = new Date(shop.nowMs).toISOString().replace('.000Z', 'Z')
      settle(shop)
      const after = await feed.poll()
      expect(after).toHaveLength(1)
      expect(after[0]).not.toHaveProperty('awaitingPayment')
      expect(after[0]!.facts).toEqual([{ id: `${order}:paid`, type: 'paid', occurredAt: paidAt, note: null }])

      // Back to on-hold after payment: the paid fact stays, so the Order is never awaiting payment again.
      shop.save(order, { status: 'on-hold' })
      settle(shop)
      const held = await feed.poll()
      expect(held[0]).not.toHaveProperty('awaitingPayment')
      expect(factTypes(held[0]!)).toEqual(['paid'])
    })

    it('failed and later paid: a cancelled fact, then a paid one under an id of its own', async () => {
      const { shop, feed } = await shopAndFeed()
      const order = shop.tick(60).place({ status: 'failed', ...unpaid })
      settle(shop)
      const failed = await feed.poll()
      expect(labels(failed)).toEqual([`order ${order}`])
      expect(failed[0]!.facts).toMatchObject([{ id: `${order}:cancelled`, type: 'cancelled' }])

      shop.pay(order)
      settle(shop)
      const paid = await feed.poll()
      expect(paid[0]).not.toHaveProperty('awaitingPayment')
      expect(paid[0]!.facts).toMatchObject([{ id: `${order}:paid`, type: 'paid' }])
    })

    it('cash on delivery: never awaiting payment and never paid, also once WooCommerce stamps a payment date at completion', async () => {
      const { shop, feed } = await shopAndFeed()
      const order = shop.tick(60).place({ payment_method: 'cod', ...unpaid })
      settle(shop)
      const placed = await feed.poll()
      expect(placed).toMatchObject([{ payment: 'cash_on_delivery', facts: [] }])
      expect(placed[0]).not.toHaveProperty('awaitingPayment')

      shop.complete(order)
      expect(shop.get(order).date_paid_gmt).not.toBeNull()
      settle(shop)
      const completed = await feed.poll()
      expect(completed[0]).not.toHaveProperty('awaitingPayment')
      expect(factTypes(completed[0]!)).toEqual(['shipped'])
    })

    it('in a plugin\'s status (packing): open, awaiting payment until WooCommerce has a payment date', async () => {
      const { shop, feed } = await shopAndFeed([{ status: 'packing', ...unpaid }, { status: 'packing' }])
      shop.tick(60).save(1).save(2)
      settle(shop)
      const items = await feed.poll()
      // Before the boundary and not in the listing (which asks for the three open statuses), but open: in full.
      expect(labels(items)).toEqual(['order 1', 'order 2'])
      expect(items[0]).toMatchObject({ awaitingPayment: true, facts: [] })
      expect(items[1]).not.toHaveProperty('awaitingPayment')
      expect(factTypes(items[1]!)).toEqual(['paid'])
    })

    it('from before the boundary, cancelled then reopened by an admin: open again, so a full Order', async () => {
      const { shop, feed } = await shopAndFeed([{ status: 'cancelled' }, {}])
      shop.tick(60).save(1, { status: 'processing' })
      settle(shop)
      const items = await feed.poll()
      expect(labels(items)).toEqual(['order 1'])
      expect(factTypes(items[0]!)).toEqual(['paid'])
    })

    it('from before the boundary, completed then reopened: still shipped, so only an update', async () => {
      const { shop, feed } = await shopAndFeed([{ status: 'completed', date_completed_gmt: '2026-10-01T09:00:00' }, {}])
      // WooCommerce keeps `date_completed` when the status moves back.
      shop.tick(60).save(1, { status: 'processing' })
      settle(shop)
      const items = await feed.poll()
      expect(labels(items)).toEqual(['update 1'])
      expect(factTypes(items[0]!)).toEqual(['paid', 'shipped'])
    })

    it('with a payment or completion date that is no date: read as not set, and the page goes on', async () => {
      // What WooCommerce before 3.0 wrote for "never", and what a plugin may leave behind.
      const { shop, feed } = await shopAndFeed([{}, {}, {}])
      const never = { date_paid_gmt: '-0001-11-30T00:00:00', date_completed_gmt: '0000-00-00T00:00:00' }
      const open = shop.tick(60).place({ status: 'on-hold', payment_method: 'bacs', ...never })
      const completed = shop.place({ status: 'completed', date_paid_gmt: '', date_completed_gmt: 'yesterday' })
      const fine = shop.place()
      settle(shop)
      const items = await feed.poll()
      expect(labels(items)).toEqual([`order ${open}`, `order ${completed}`, `order ${fine}`])
      // Not shipped and not paid because of a date that says "never".
      expect(items[0]).toMatchObject({ awaitingPayment: true, facts: [] })
      // The status still says completed: paid and shipped, at the time of the last change.
      const modified = `${String(shop.get(completed).date_modified_gmt)}Z`
      expect(items[1]!.facts).toEqual([
        { id: `${completed}:paid`, type: 'paid', occurredAt: modified, note: null },
        { id: `${completed}:shipped`, type: 'shipped', occurredAt: modified, note: null },
      ])
    })

    it('with more lines than an order has, or an amount longer than an amount is: does not fit, and the page goes on', async () => {
      const { shop, feed } = await shopAndFeed([{}, {}])
      shop.tick(60)
      const lines = shop.place({ line_items: Array.from({ length: 1001 }, (_, index) => rawLine(2, { id: 5000 + index })) })
      const total = shop.place({ total: '9'.repeat(5000) })
      const lineTotal = shop.place({ line_items: [rawLine(2, { total: `${'1'.repeat(100)}.00` })] })
      const closed = shop.place({ status: 'cancelled', total: '9'.repeat(5000) })
      const fine = shop.place({ line_items: Array.from({ length: 1000 }, (_, index) => rawLine(2, { id: 7000 + index })) })
      settle(shop)
      const items = await feed.poll()
      expect(labels(items)).toEqual([`update ${closed}`, `order ${fine}`])
      expect((items[1] as Order).lines).toHaveLength(1000)
      expect(shop.logs.map(({ fields }) => fields)).toEqual([
        { orderId: lines, problems: ['lines'] },
        { orderId: total, problems: ['total.amount'] },
        { orderId: lineTotal, problems: ['lines.0.unitPrice.amount'] },
      ])
    })

    it('a Buyer\'s 100,000 characters in an address field do not stop the page', async () => {
      const { shop, feed } = await shopAndFeed([{}])
      const long = 'x'.repeat(100_000)
      const order = shop.tick(60).place({ billing: { ...(rawOrder().billing as object), address_2: long, company: long }, shipping: { ...(rawOrder().shipping as object), address_2: long } })
      settle(shop)
      const items = await feed.poll()
      expect(labels(items)).toEqual([`order ${order}`])
      expect((items[0] as Order).shippingAddress.street.length).toBeLessThan(1100)
    })

    it('deleted for good: gone from the feed without a word (a known gap)', async () => {
      const { shop, feed } = await shopAndFeed()
      shop.tick(60).remove(1)
      settle(shop)
      expect(await feed.poll()).toEqual([])
    })
  })

  describe('the SKU of a variation line', () => {
    // Product 19 is a variable product with the SKU WOO-TSHIRT; its variation 20 has its own, 21 inherits.
    const lines = { line_items: [rawLine(0), rawLine(1), rawLine(2)] }
    const skus = (item: OrderFeedItem | undefined) => (item as Order).lines.map((line) => line.sku)

    async function shopAndFeed() {
      const shop = shopWith([]).product(19, 'WOO-TSHIRT').product(10, 'WOO-MUG-1')
      const feed = await connected(shop)
      shop.tick(60)
      return { shop, feed }
    }

    it('is left out when it is the parent\'s, kept when it is the variation\'s own', async () => {
      const { shop, feed } = await shopAndFeed()
      shop.place(lines)
      settle(shop)
      const items = await feed.poll()
      expect(skus(items[0])).toEqual(['WOO-TSHIRT-S', null, 'WOO-MUG-1'])
      expect((items[0] as Order).lines.map((line) => line.offerExternalId)).toEqual(['19:20', '19:21', '10'])
      // One request for the parents of the page, and only for them: product 10 is no variation.
      expect(shop.urls.filter((url) => url.includes('products'))).toEqual(['GET products?include=19&per_page=100&_fields=id,sku'])
    })

    it('asks once for all the orders of a page', async () => {
      const { shop, feed } = await shopAndFeed()
      shop.product(24, '')
      shop.place(lines)
      shop.place({ line_items: [rawLine(1, { id: 90, product_id: 24, variation_id: 25, sku: 'WOO-HOODIE-BLK-M' })] })
      settle(shop)
      const items = await feed.poll()
      expect(items.map(skus)).toEqual([['WOO-TSHIRT-S', null, 'WOO-MUG-1'], ['WOO-HOODIE-BLK-M']])
      expect(shop.urls.filter((url) => url.includes('products'))).toEqual(['GET products?include=19,24&per_page=100&_fields=id,sku'])
    })

    it('makes no request when no line is a variation with a SKU, or when only updates are reported', async () => {
      const { shop, feed } = await shopAndFeed()
      shop.place()
      shop.place({ line_items: [rawLine(1, { sku: '' })] })
      settle(shop)
      await feed.poll()
      expect(shop.urls.filter((url) => url.includes('products'))).toEqual([])
    })

    it('is left out when the parent is gone: nobody can say whose SKU it is', async () => {
      const { shop, feed } = await shopAndFeed()
      shop.place({ line_items: [rawLine(0, { product_id: 77, variation_id: 78 }), rawLine(2)] })
      settle(shop)
      expect(skus((await feed.poll())[0])).toEqual([null, 'WOO-MUG-1'])
    })

    it('is left out when the key may read orders but not products, and the feed goes on', async () => {
      const { shop, feed } = await shopAndFeed()
      shop.productsStatus = 403
      const order = shop.place(lines)
      settle(shop)
      const items = await feed.poll()
      expect(labels(items)).toEqual([`order ${order}`])
      // Also the variation's own SKU: without the parents it cannot be told from an inherited one.
      expect(skus(items[0])).toEqual([null, null, 'WOO-MUG-1'])
      expect(shop.logs).toEqual([
        { message: 'WooCommerce did not say which SKUs variations inherit: lines of variations are imported without a SKU', fields: { products: 1 } },
      ])
    })

    it.each([
      [500, 'transient'],
      [401, 'auth_expired'],
      [429, 'rate_limited'],
    ])('fails the call when the products request fails with %d, so the page is read again', async (status, kind) => {
      const { shop, feed } = await shopAndFeed()
      shop.productsStatus = status
      shop.place(lines)
      settle(shop)
      const error = await pull(shop, feed.cursor).catch((caught: unknown) => caught)
      expect(classifyConnectorError(error).kind).toBe(kind)
    })

    it('asks about the parents of a page in a few requests at most, and leaves the SKU off the lines of the rest', async () => {
      const { shop, feed } = await shopAndFeed()
      // Two orders of 400 variation lines each, every line of another variable product.
      for (const first of [0, 400]) {
        shop.place({ line_items: Array.from({ length: 400 }, (_, index) => rawLine(0, { id: 1000 + first + index, product_id: 500 + first + index, variation_id: 9000 + first + index, sku: `SKU-${first + index}` })) })
      }
      for (let index = 0; index < 800; index++) shop.product(500 + index, '')
      settle(shop)
      const items = await feed.poll()
      expect(shop.requests.filter(({ path }) => path === 'products')).toHaveLength(3)
      const all = items.flatMap((item) => (item as Order).lines.map((line) => line.sku))
      // The 300 lowest ids were asked about; their lines keep their own SKUs.
      expect(all.filter((sku) => sku !== null)).toEqual(Array.from({ length: 300 }, (_, index) => `SKU-${index}`))
      expect(shop.logs).toEqual([
        { message: 'WooCommerce orders name more variable products than one call asks about: the lines of the others are imported without a SKU', fields: { products: 800, asked: 300 } },
      ])
    })

    it('asks for at most 100 parents per request', async () => {
      const { shop, feed } = await shopAndFeed()
      const many = Array.from({ length: 150 }, (_, index) => rawLine(0, { id: 1000 + index, product_id: 500 + index, variation_id: 2000 + index, sku: `SKU-${index}` }))
      shop.place({ line_items: many })
      for (let index = 0; index < 150; index++) shop.product(500 + index, index === 3 ? 'SKU-3' : '')
      settle(shop)
      const item = (await feed.poll())[0]
      expect(shop.requests.filter(({ path }) => path === 'products').map(({ query }) => query.include!.split(',').length)).toEqual([100, 50])
      expect(skus(item).filter((sku) => sku === null)).toHaveLength(1)
      expect(skus(item)[3]).toBeNull()
    })
  })
})

describe('a shop that keeps no order inside a second (WooCommerce before 10.4.0)', () => {
  // There `orderby=modified` has no tie-break: the orders of one second come back in another order on every
  // request, also on two `offset` pages of one list. Nothing may depend on where in its second an order stands.
  function unorderedShop(orders: number): FakeShop {
    const shop = shopWith(Array.from({ length: orders }, () => ({})))
    shop.unorderedSeconds = true
    return shop
  }

  it.each([
    ['three a second', 3],
    ['ten a second', 10],
    ['forty-five a second, so a page ends inside a second', 45],
    ['a hundred a second, so one second fills a page', 100],
    ['all in one second', 130],
  ])('130 changes between two polls, %s: every Order placed and every completion arrives, once', async (_, perSecond) => {
    const shop = unorderedShop(80)
    const feed = new Feed(shop, { pageSize: 100 })
    expect(await feed.poll()).toHaveLength(80)

    // Seventy orders are placed and sixty of the eighty known ones are completed, mixed, several in each second.
    shop.tick(60)
    const placed: number[] = []
    const completed: number[] = []
    for (let change = 0; change < 130; change++) {
      if (change > 0 && change % perSecond === 0) shop.tick(1)
      if (change % 13 < 7) placed.push(shop.place())
      else {
        completed.push(completed.length + 1)
        shop.complete(completed.length)
      }
    }
    expect([placed.length, completed.length]).toEqual([70, 60])
    settle(shop)

    const items = await feed.poll()
    const reported = new Map(items.map((item) => [item.externalId, item]))
    // An Order that is never imported never reserves; a completion that is lost never releases its Reservation.
    expect(placed.filter((id) => !reported.has(String(id))), 'Orders placed and never reported').toEqual([])
    expect(completed.filter((id) => !reported.get(String(id))?.facts.some((fact) => fact.type === 'shipped')), 'completions never reported').toEqual([])
    expect(items).toHaveLength(130)
    expect(placed.every((id) => !isOrderUpdate(reported.get(String(id))!))).toBe(true)
    expect(completed.every((id) => isOrderUpdate(reported.get(String(id))!))).toBe(true)
    // Two lists of three requests at most; no line is a variation.
    expect(Math.max(...feed.requestsPerCall)).toBeLessThanOrEqual(2 * MAX_RUN_REQUESTS)
    // And nothing is left behind.
    settle(shop)
    expect(await feed.poll()).toEqual([])
  })

  it('a shop that lists the trash under any as well (seen on 10.3.8 with HPOS) gets each trashed order reported once', async () => {
    const shop = unorderedShop(6)
    shop.listsTrashUnderAny = true
    shop.listsDraftsUnderAny = true
    const feed = new Feed(shop)
    await feed.poll()
    shop.tick(60).trash(2).save(3)
    const draft = shop.place({ status: 'checkout-draft', date_paid_gmt: null })
    shop.tick(1).trash(5).cancel(6)
    settle(shop)
    // 2 and 5 are in both lists with one and the same snapshot; the draft is in the list and is no order yet.
    expect(labels(await feed.poll())).toEqual(['update 2', 'order 3', 'update 5', 'update 6'])
    expect(draft).toBe(7)
  })

  it('more changes of one second than fit a page, with small pages: each once, whatever order the shop is in', async () => {
    const shop = unorderedShop(11)
    const feed = new Feed(shop)
    await feed.poll()
    shop.tick(100)
    for (let id = 11; id >= 1; id--) shop.save(id)
    settle(shop)
    expect(labels(await feed.poll()).sort()).toEqual(Array.from({ length: 11 }, (_, index) => `order ${index + 1}`).sort())
  })

  it('an order saved again while the shop answers the read of one second is left for its new second', async () => {
    const shop = unorderedShop(5)
    const feed = new Feed(shop)
    await feed.poll()
    shop.tick(100)
    for (let id = 1; id <= 5; id++) shop.save(id)
    settle(shop)
    await feed.page()
    expect(feed.cursor).toMatch(/^s1:/)

    // The shop finds order 2 in that second, and by the time it writes the answer the order carries a later stamp.
    const later = new Date(shop.nowMs).toISOString().slice(0, 19)
    const context = shop.context()
    const racing: typeof context = {
      ...context,
      fetch: async (input, init) => {
        const response = await context.fetch(input, init)
        if (!String(input).includes('orderby=id')) return response
        const orders = (await response.json()) as Array<{ id: number; date_modified_gmt: string }>
        return new Response(JSON.stringify(orders.map((order) => (order.id === 2 ? { ...order, date_modified_gmt: later } : order))), { headers: response.headers })
      },
    }
    const page = await pullOrders(racing, feed.cursor, { pageSize: 3, holdBackSeconds: HOLD_BACK })
    // Not reported as a change of this second; its place among the ids is passed all the same.
    expect(labels(page.items)).toEqual(['order 1', 'order 3'])
    expect(page.nextCursor).toMatch(/^s1:\d+:5:\d+:3:3:0$/)
  })

  it('a page that ends inside a second does not carry the position into it', async () => {
    const shop = unorderedShop(8)
    const feed = new Feed(shop)
    await feed.poll()
    // Two changes in one second, then four in the next: the first page of three ends inside the second one.
    shop.tick(100).save(8).save(7)
    shop.tick(1).save(1).save(2).save(3).save(4)
    shop.tick(1).save(5)
    settle(shop)
    const first = await feed.page()
    expect(labels(first.items).sort()).toEqual(['order 7', 'order 8'])
    expect(first.hasMore).toBe(true)
    // The position rests at the end of the second that was read whole, not at an order of the one that was cut.
    expect(feed.cursor).toMatch(new RegExp(`^c1:\\d+:8:${shop.second - HOLD_BACK - 3}:8:2:0$`))
    expect(labels(await feed.poll()).sort()).toEqual(['order 1', 'order 2', 'order 3', 'order 4', 'order 5'])
  })
})

describe('a cursor it did not write', () => {
  it.each(['', 'garbage', 'e1:12:13', 'l1:1:2:3:4', 'c1:1:2:3:4:5:6:7', 'l2:1:2:3:4:5'])('%j is a permanent failure, not an expired cursor, and makes no request', async (cursor) => {
    const shop = shopWith([{}])
    const error = await pull(shop, cursor).catch((caught: unknown) => caught)
    expect(classifyConnectorError(error).kind).toBe('permanent')
    expect(isCursorExpiredError(error)).toBe(false)
    expect(shop.requests).toEqual([])
  })
})

describe('a shop that does not answer with orders', () => {
  // Hand-written answers: the sandbox cannot be made to send a 429 or a 500, and the bodies are WooCommerce's own.
  function contextAnswering(response: () => Response): WooCommerceContext {
    return { app: {}, config: replayConfig, credentials: replayCredentials, fetch: async () => response(), log: () => {} }
  }
  const wooError = (status: number, code: string, headers: Record<string, string> = {}) => () =>
    new Response(JSON.stringify({ code, message: 'Sorry, you cannot list resources.', data: { status } }), { status, headers: { 'content-type': 'application/json', ...headers } })
  const options = { pageSize: 3, holdBackSeconds: HOLD_BACK }
  const cursors = [null, 'l1:1791633578:57:0:0:0', 'c1:1791633578:57:1791633578:0:0:0']

  it.each([
    ['an unknown key', wooError(401, 'woocommerce_rest_cannot_view'), 'auth_expired'],
    ['a wrong secret', wooError(401, 'woocommerce_rest_authentication_error'), 'auth_expired'],
    ['a key without the right to read orders', wooError(403, 'woocommerce_rest_cannot_view'), 'permanent'],
    ['a server error', wooError(500, 'internal_server_error'), 'transient'],
    ['a gateway that timed out', () => new Response('<html>504</html>', { status: 504, headers: { 'content-type': 'text/html' } }), 'transient'],
    ['a firewall page with status 200', () => new Response('<html>Checking your browser</html>', { status: 200, headers: { 'content-type': 'text/html' } }), 'permanent'],
    ['JSON of another shape', () => new Response(JSON.stringify({ orders: [] }), { status: 200, headers: { 'content-type': 'application/json' } }), 'permanent'],
  ])('%s fails every phase as %s', async (_, response, kind) => {
    for (const cursor of cursors) {
      const error = await pullOrders(contextAnswering(response), cursor, options).catch((caught: unknown) => caught)
      expect(classifyConnectorError(error).kind, `cursor ${cursor}`).toBe(kind)
    }
  })

  it('a 429 is a rate limit that waits as long as Retry-After says', async () => {
    for (const cursor of cursors) {
      const error = await pullOrders(contextAnswering(wooError(429, 'too_many_requests', { 'retry-after': '17' })), cursor, options).catch((caught: unknown) => caught)
      expect(classifyConnectorError(error)).toMatchObject({ kind: 'rate_limited', retryAfterMs: 17_000 })
    }
  })

  it('never puts the answer\'s content into the error', async () => {
    const body = JSON.stringify([{ ...rawOrder(), id: 'not a number' }])
    const error = (await pullOrders(contextAnswering(() => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })), cursors[1]!, options).catch(
      (caught: unknown) => caught,
    )) as Error
    expect(classifyConnectorError(error).kind).toBe('permanent')
    expect(error.message).toContain('0.id')
    expect(error.message).not.toMatch(/Ewa|Fikcyjna|example\.test|Wrocław/)
  })

  it('a failure of the network is transient', async () => {
    const ctx: WooCommerceContext = {
      app: {},
      config: replayConfig,
      credentials: replayCredentials,
      fetch: async () => {
        throw new TypeError('fetch failed')
      },
      log: () => {},
    }
    for (const cursor of cursors) {
      expect(classifyConnectorError(await pullOrders(ctx, cursor, options).catch((caught: unknown) => caught)).kind).toBe('transient')
    }
  })
})

describe('what the feed promises over time', () => {
  it('a fact id keeps its meaning, and no Order is ever both awaiting payment and paid', async () => {
    const shop = shopWith([{}, { status: 'on-hold', ...unpaid }, { payment_method: 'cod', ...unpaid }])
    const feed = new Feed(shop, { pageSize: 2 })
    const items: OrderFeedItem[] = await feed.poll()
    const act: Array<() => void> = [
      () => shop.place({ status: 'pending', ...unpaid }),
      () => shop.pay(2).pay(4),
      () => shop.complete(1).complete(3).save(4, { status: 'on-hold' }),
      () => shop.save(1, { status: 'refunded' }).trash(2).complete(4),
      () => shop.save(2, { status: 'processing' }).save(4, { status: 'failed' }),
    ]
    for (const step of act) {
      shop.tick(30)
      step()
      settle(shop)
      items.push(...(await feed.poll()))
    }

    const meaning = new Map<string, string>()
    for (const item of items) {
      for (const fact of item.facts) {
        expect(fact.id).toBe(`${item.externalId}:${fact.type}`)
        expect(meaning.get(fact.id) ?? fact.type).toBe(fact.type)
        meaning.set(fact.id, fact.type)
      }
      if (isOrderUpdate(item)) continue
      const full: Order = item
      if (full.awaitingPayment === true) {
        expect(full.payment).toBe('prepaid')
        expect(factTypes(full)).not.toContain('paid')
      }
    }
    // Conformance check C6 over the whole feed: whoever was awaiting payment and comes back without the flag has a fact that ends the wait.
    const waiting = new Set<string>()
    for (const item of items) {
      const ends = item.facts.some((fact) => fact.type === 'paid' || fact.type === 'cancelled')
      if (isOrderUpdate(item)) {
        if (ends) waiting.delete(item.externalId)
      } else if (item.awaitingPayment === true) waiting.add(item.externalId)
      else if (waiting.delete(item.externalId)) expect(ends, `Order ${item.externalId} lost the flag without a fact`).toBe(true)
    }
    expect(items.filter((item): item is OrderUpdate => isOrderUpdate(item)).length).toBeGreaterThan(0)
  })
})
