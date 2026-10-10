import { isOrderUpdate, orderSchema, orderUpdateSchema, type OrderFeedItem } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { wooOrderSchema } from '../api'
import { isOpen, orderFacts } from '../mapping/order'
import { isDraftStatus, OPEN_STATUSES } from '../mapping/status'
import { FakeShop } from '../testing/orders-fake-shop'
import { parseCursor } from './orders-cursor'
import { pullOrders } from './orders-pull'
import { MAX_RUN_REQUESTS } from './orders-stream'

// The whole feed against a shop that never holds still: orders are placed, paid, closed, reopened, trashed, restored
// and deleted between the calls and between the requests of one call, during the listing and during the changes.
// Seeded, so a failure names the run that reproduces it. What must hold whatever happened: once the shop is quiet,
// the last thing the feed said about every order is the truth about it.

const RUNS = 200

/** The same numbers on every run of the suite. */
function random(seed: number) {
  let state = seed
  return (below: number) => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return Math.floor((state / 2_147_483_648) * below)
  }
}

const unpaid = { date_paid_gmt: null }
// What an order can be placed as: WooCommerce's open statuses, a plugin's, a checkout nobody finished, a failed payment.
const PLACED_AS: Array<Record<string, unknown>> = [
  { status: 'processing' },
  { status: 'processing', payment_method: 'cod', ...unpaid },
  { status: 'on-hold', payment_method: 'bacs', ...unpaid },
  { status: 'pending', ...unpaid },
  { status: 'packing' },
  { status: 'packing', ...unpaid },
  { status: 'checkout-draft', ...unpaid },
  { status: 'failed', ...unpaid },
]
// What a shop holds before the Connection, besides those.
const HISTORY: Array<Record<string, unknown>> = [{ status: 'completed', date_completed_gmt: '2026-09-01T10:00:00' }, { status: 'cancelled', ...unpaid }, { status: 'refunded' }]

interface Outcome {
  /** The last item the feed returned for each order. */
  last: Map<string, OrderFeedItem>
  start: number
  boundary: number
  calls: number
}

/** One Connection on a restless shop: connects, is polled while the shop changes, then polled until the shop is quiet. */
async function run(seed: number): Promise<{ shop: FakeShop; outcome: Outcome }> {
  const pick = random(seed)
  const options = { pageSize: 2 + pick(3), holdBackSeconds: pick(2) * 2 }
  const shop = new FakeShop('2026-10-01T08:00:00Z')
  const trashed = new Set<number>()

  const anyOf = (ids: number[]) => (ids.length === 0 ? null : ids[pick(ids.length)]!)
  const statusOf = (id: number) => String(shop.get(id).status)
  const living = () => shop.ids.filter((id) => !trashed.has(id))
  const actions: Array<() => void> = [
    () => void shop.place(PLACED_AS[pick(PLACED_AS.length)]!),
    () => {
      const id = anyOf(living().filter((candidate) => !isDraftStatus(statusOf(candidate))))
      if (id !== null) pick(2) === 0 ? shop.cancel(id) : shop.complete(id)
    },
    () => {
      // Not a checkout that was never placed: in the trash it looks like any trashed order, and is reported as one.
      const id = anyOf(living().filter((candidate) => !isDraftStatus(statusOf(candidate))))
      if (id === null) return
      shop.trash(id)
      trashed.add(id)
    },
    () => {
      const id = anyOf([...trashed])
      if (id === null) return
      shop.restore(id)
      trashed.delete(id)
    },
    () => {
      const id = anyOf(living().filter((candidate) => isDraftStatus(statusOf(candidate))))
      if (id !== null) shop.save(id, { status: 'pending' })
    },
    () => {
      const id = anyOf(living().filter((candidate) => ['pending', 'on-hold', 'failed', 'packing'].includes(statusOf(candidate))))
      if (id !== null) shop.pay(id)
    },
    () => {
      // Reopened by an admin; WooCommerce keeps the completion date.
      const id = anyOf(living().filter((candidate) => ['completed', 'cancelled', 'refunded'].includes(statusOf(candidate))))
      if (id !== null) shop.save(id, { status: 'processing' })
    },
    () => {
      const id = anyOf(living())
      if (id !== null) shop.save(id)
    },
    () => {
      // Rarely: deleted for good.
      const id = pick(4) === 0 ? anyOf(shop.ids) : null
      if (id === null) return
      shop.remove(id)
      trashed.delete(id)
    },
  ]
  const change = () => actions[pick(actions.length)]!()

  // Before the Connection: some orders created in the same second, some already in the trash.
  for (let count = 4 + pick(20); count > 0; count--) {
    const kinds = [...PLACED_AS, ...HISTORY]
    const id = shop.place(kinds[pick(kinds.length)]!)
    if (pick(8) === 0 && !isDraftStatus(statusOf(id))) {
      shop.trash(id)
      trashed.add(id)
    }
    shop.tick(pick(3))
  }
  shop.tick(100 + pick(100))

  const outcome: Outcome = { last: new Map(), start: 0, boundary: 0, calls: 0 }
  let cursor: string | null = null
  const call = async (): Promise<boolean> => {
    const before = shop.requests.length
    const result = await pullOrders(shop.context(), cursor, options)
    const requests = shop.requests.length - before
    outcome.calls++
    const where = `seed ${seed}, call ${outcome.calls}, cursor ${cursor}`

    // The start: two. The listing: one list. The changes: two lists. No line is a variation here.
    const most = cursor === null ? 2 : cursor.startsWith('l1:') ? MAX_RUN_REQUESTS : 2 * MAX_RUN_REQUESTS
    expect(requests, `${where}: requests`).toBeLessThanOrEqual(most)
    if (result.hasMore) expect(result.nextCursor, `${where}: hasMore with an unchanged cursor`).not.toBe(cursor)
    expect(result.nextCursor, where).not.toBeNull()
    expect(new Set(result.items.map((item) => item.externalId)).size, `${where}: an order twice on one page`).toBe(result.items.length)
    for (const item of result.items) {
      expect((isOrderUpdate(item) ? orderUpdateSchema : orderSchema).safeParse(item).success, `${where}: item ${item.externalId}`).toBe(true)
      outcome.last.set(item.externalId, item)
    }
    if (cursor === null) {
      const started = parseCursor(result.nextCursor!)
      outcome.start = started.start
      outcome.boundary = started.boundary
    }
    cursor = result.nextCursor
    return result.hasMore
  }

  // While the shop changes: also between the two or three requests of one call, and the clock moves on meanwhile.
  shop.beforeAnswer = () => {
    if (pick(4) === 0) change()
    if (pick(6) === 0) shop.tick(1)
  }
  for (let calls = 30 + pick(50); calls > 0; calls--) {
    await call()
    for (let changes = pick(3); changes > 0; changes--) change()
    shop.tick(pick(3))
  }

  // The shop is quiet: the feed catches up.
  shop.beforeAnswer = null
  for (let rounds = 0; rounds < 2; rounds++) {
    shop.tick(options.holdBackSeconds + 2)
    let more = true
    for (let calls = 0; more; calls++) {
      if (calls > 500) throw new Error(`seed ${seed}: the feed never ended`)
      more = await call()
    }
  }
  expect(cursor, `seed ${seed}`).toMatch(/^c1:/)
  return { shop, outcome }
}

describe('orders.pull on a shop that changes all the time', () => {
  // 200 runs take about 2 s alone and 7 s beside the other packages' tests: more than vitest's default 5 s.
  it('in the end the last report of every order is its final state, as a full Order or an update by the rule', { timeout: 60_000 }, async () => {
    let fullOrders = 0
    let updates = 0
    const unreported = new Set<string>()
    for (let seed = 1; seed <= RUNS; seed++) {
      const { shop, outcome } = await run(seed)
      for (const id of shop.ids) {
        const order = wooOrderSchema.parse(shop.get(id))
        const last = outcome.last.get(String(id))
        const where = `seed ${seed}, order ${id} (${order.status}, modified ${order.date_modified_gmt}, boundary ${outcome.boundary})`

        if (isDraftStatus(order.status)) {
          // Never placed: never reported.
          expect(last, where).toBeUndefined()
          continue
        }
        const open = isOpen(order)
        const changedSinceStart = Date.parse(`${order.date_modified_gmt}Z`) / 1000 >= outcome.start
        // Open orders in one of WooCommerce's own open statuses are listed at the start; everything else, an order
        // waiting in a plugin's status too, is reported only when it changes.
        const listedAtStart = open && (OPEN_STATUSES as readonly string[]).includes(order.status)
        if (listedAtStart || changedSinceStart) expect(last, `${where}: never reported`).toBeDefined()
        // The known gap, and nothing wider: an order nobody touched since the start is unreported only if it is closed or in a plugin's status.
        if (last === undefined) {
          expect(changedSinceStart, where).toBe(false)
          unreported.add(open ? order.status : 'closed')
          continue
        }

        expect(last.facts, `${where}: facts`).toEqual(orderFacts(order))
        // Full while open or when placed after the boundary; an update for an order from before it that is closed.
        expect(isOrderUpdate(last), `${where}: full Order or update`).toBe(!(open || id > outcome.boundary))
        if (isOrderUpdate(last)) updates++
        else fullOrders++
      }
    }
    // The runs really went through both kinds.
    expect(fullOrders).toBeGreaterThan(RUNS)
    expect(updates).toBeGreaterThan(RUNS / 2)
    expect([...unreported].sort()).toEqual(['closed', 'packing'])
  })
})
