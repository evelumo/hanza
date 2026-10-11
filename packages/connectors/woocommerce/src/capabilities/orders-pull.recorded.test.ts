import { classifyConnectorError, type Order, type OrderFeedItem } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { createWooCommerceConnector } from '../connector'
import { expectId, factTypes, feedOf, label, labels, newOrder } from '../testing/orders-recorded-feed'
import { withOrdersScenario } from '../testing/orders-scenario'
import { parseCursor } from './orders-cursor'

// The Order feed against the recorded sandbox shop (WooCommerce 11.2.1, HPOS, site time Europe/Warsaw; see
// sandbox/README.md for the seed). To record the cassettes again, all of them and in this order, from a fresh shop:
//
//   WOO_SANDBOX_PROJECT=<name> WOO_SANDBOX_PORT=<port> sandbox/sandbox.sh reset
//   WOO_SANDBOX_PROJECT=<name> WOO_SANDBOX_PORT=<port> HANZA_RECORD_FIXTURES=1 \
//     pnpm --filter @hanza/connector-woocommerce exec vitest run src/capabilities/orders-pull.recorded.test.ts
//
// The first scenario needs the seed untouched, and the later ones change the shop between two pulls (through the
// sandbox, never through the recorder) and create orders 58 to 63, which the expectations name. While recording, a
// scenario waits out its seconds; on replay nothing waits and nothing changes: the cassette holds what followed.
// The times of the shop's answers are in the cassettes (`Date`), so no request depends on the clock of the replay.

const RECORDING_TIMEOUT = 120_000

describe('orders.pull against the recorded shop', () => {
  it(
    'the first pull: the start, the open orders over several pages, then the changes with nothing new',
    () =>
      withOrdersScenario('orders-first-pull', async (scenario) => {
        // The hold-back of a real Connection.
        const feed = feedOf(scenario, { pageSize: 5 })

        const start = await feed.page()
        expect(start).toMatchObject({ items: [], hasMore: true })
        // The newest order, 57, is the boundary; nothing is in the trash.
        expect(start.nextCursor).toMatch(/^l1:\d{10}:57:0:0:0$/)
        expect(scenario.requests).toEqual(['GET orders?status=any&orderby=id&order=desc&per_page=1&_fields=id', 'GET orders?status=trash&orderby=id&order=desc&per_page=1&_fields=id'])

        const pages: string[][] = []
        const listed: OrderFeedItem[] = []
        while (feed.cursor!.startsWith('l1:')) {
          const page = await feed.page()
          expect(page.hasMore).toBe(true)
          pages.push(labels(page.items))
          listed.push(...page.items)
        }
        // By creation time, then id: 57 has the highest id and the earliest time. 44 (no lines) and 45 (no address)
        // are open but do not fit the canonical Order. 47 waits in a plugin's status, `packing`, and is not listed:
        // the listing asks for WooCommerce's own three open statuses only.
        expect(pages).toEqual([
          ['order 57', 'order 30', 'order 31', 'order 32', 'order 33'],
          ['order 39', 'order 40', 'order 41', 'order 42'],
          ['order 43', 'order 49'],
          ['order 50', 'order 51', 'order 52', 'order 53'],
          ['order 54', 'order 55', 'order 56'],
        ])
        expect(scenario.logs).toEqual([
          { message: 'WooCommerce order skipped: it does not fit the canonical Order', fields: { orderId: 44, problems: ['lines'] } },
          { message: 'WooCommerce order skipped: it does not fit the canonical Order', fields: { orderId: 45, problems: ['buyer.name', 'shippingAddress'] } },
        ])

        const listing = scenario.requests.filter((request) => request.includes('orderby=date'))
        expect(listing).toHaveLength(5)
        expect(listing[0]).toMatch(/^GET orders\?status=pending,on-hold,processing&orderby=date&per_page=5&order=asc&_fields=id,status,/)
        // Order 33 was created at 06:30:00 UTC (08:30 in Warsaw): its second is asked for again, in UTC.
        expect(listing[1]).toContain('&after=2026-09-21T06:29:59Z&order=asc')
        // 52 and 53 were created in the same second, and the page ended on 53: one entry of that second is skipped.
        expect(listing[4]).toContain('&after=2026-09-21T09:29:59Z&offset=1&order=asc')
        // Nothing but the start, the listing, the parents of variation lines and the changes is ever asked.
        expect(scenario.requests.filter((request) => !/^GET (orders|products)\?/.test(request))).toEqual([])
        expect(scenario.requests.join('\n')).not.toContain('dates_are_gmt')

        const byId = new Map(listed.map((item) => [item.externalId, item as Order]))
        // Paid online.
        expect(byId.get('30')).toMatchObject({ placedAt: '2026-09-21T06:00:00Z', payment: 'prepaid', facts: [{ id: '30:paid', type: 'paid', occurredAt: '2026-09-21T06:02:00Z', note: null }] })
        expect(byId.get('30')).not.toHaveProperty('awaitingPayment')
        // Cash on delivery: nothing to wait for, nothing paid.
        expect(byId.get('31')).toMatchObject({ payment: 'cash_on_delivery', facts: [] })
        expect(byId.get('31')).not.toHaveProperty('awaitingPayment')
        // A bank transfer that has not arrived, and a checkout that was never paid.
        expect(byId.get('32')).toMatchObject({ payment: 'prepaid', awaitingPayment: true, facts: [] })
        expect(byId.get('33')).toMatchObject({ payment: 'prepaid', awaitingPayment: true, facts: [] })
        expect(byId.has('47')).toBe(false)
        // On hold again after it was paid: the payment stays a fact.
        expect(factTypes(byId.get('49'))).toEqual(['paid'])
        expect(byId.get('49')).not.toHaveProperty('awaitingPayment')
        // Variation 21 has no SKU of its own and its line carries the parent's, which is left out; 20 has its own.
        expect(byId.get('39')!.lines.map((line) => [line.offerExternalId, line.sku])).toEqual([
          ['19:20', 'WOO-TSHIRT-S'],
          ['19:21', null],
          ['10', 'WOO-MUG-1'],
          ['12', null],
        ])
        // The product of the first line was deleted.
        expect(byId.get('43')!.lines[0]).toMatchObject({ offerExternalId: null, sku: null })
        // Virtual goods have no shipping address: the billing one stands in.
        expect(byId.get('40')!.shippingAddress).toEqual(byId.get('40')!.billingAddress)
        // A variation with a SKU of its own keeps it: 25 under a parent without a SKU, 22 under one with another SKU.
        expect(byId.get('41')!.lines.map((line) => [line.offerExternalId, line.sku])).toEqual([['24:25', 'WOO-HOODIE-BLK-M']])
        expect(byId.get('52')!.lines.map((line) => [line.offerExternalId, line.sku])).toContainEqual(['19:22', 'WOO-TSHIRT-L'])
        // One look at the parents of a page's variation lines, and only on the pages that have such lines (39 and 41, then 52).
        expect(scenario.requests.filter((request) => request.includes('products'))).toEqual([
          'GET products?include=19,24&per_page=100&_fields=id,sku',
          'GET products?include=19&per_page=100&_fields=id,sku',
        ])

        // The changes start at the start, taken before the listing; the seed is older than that.
        const { start: position } = parseCursor(start.nextCursor!)
        expect(feed.cursor).toBe(`c1:${position}:57:${position}:0:0:0`)
        expect(await feed.page()).toEqual({ items: [], nextCursor: feed.cursor, hasMore: false })
        expect(scenario.requests.slice(-2)).toEqual([
          expect.stringMatching(/^GET orders\?status=any&orderby=modified&per_page=5&modified_after=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z&order=asc&_fields=id,status,/),
          expect.stringMatching(/^GET orders\?status=trash&orderby=modified&per_page=5&modified_after=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z&order=asc&_fields=id,status,/),
        ])
      }),
    RECORDING_TIMEOUT,
  )

  it(
    'an order that closes between two listing pages makes no other order skipped; one waiting in a plugin\'s status that then completes is never imported',
    () =>
      withOrdersScenario('orders-listing-close', async (scenario) => {
        const feed = feedOf(scenario, { pageSize: 5, holdBackSeconds: 0 })
        await feed.page()
        expect(labels((await feed.page()).items)).toEqual(['order 57', 'order 30', 'order 31', 'order 32', 'order 33'])

        // 31 was listed and is cancelled; 50 is completed before the listing reaches it.
        await scenario.change(async (sandbox) => {
          await sandbox.put('orders/31', { status: 'cancelled' })
          await sandbox.put('orders/50', { status: 'completed' })
        })

        const rest: OrderFeedItem[] = []
        while (feed.cursor!.startsWith('l1:')) rest.push(...(await feed.page()).items)
        // By offset, 39 would be skipped (31 left the list before it). 50 is closed and never imported. 47, in the
        // plugin's status `packing`, is not listed.
        expect(labels(rest)).toEqual(['order 39', 'order 40', 'order 41', 'order 42', 'order 43', 'order 49', 'order 51', 'order 52', 'order 53', 'order 54', 'order 55', 'order 56'])

        // THE GAP, as the real shop shows it: the order in the plugin's status completes with no other change
        // since the Connection started.
        await scenario.change((sandbox) => sandbox.put('orders/47', { status: 'completed' }))
        await scenario.settle()
        const changes = await feed.poll()
        // All three are from before the boundary and closed: facts only. Hanza has 31 and cancels it. It never had
        // 50, which closed before the listing reached it, nor 47, which was never listed: the core ignores both
        // updates, so 47's units are never taken off Stock though they left the shelf.
        const closed = new Map(changes.map((item) => [label(item), item]))
        expect([...closed.keys()].sort()).toEqual(['update 31', 'update 47', 'update 50'])
        expect(closed.get('update 31')!.facts).toEqual([{ id: '31:cancelled', type: 'cancelled', occurredAt: expect.stringMatching(/Z$/), note: 'WooCommerce status: cancelled' }])
        expect(factTypes(closed.get('update 50'))).toEqual(['paid', 'shipped'])
        expect(factTypes(closed.get('update 47'))).toEqual(['paid', 'shipped'])
        expect(await feed.page()).toEqual({ items: [], nextCursor: feed.cursor, hasMore: false })
      }),
    RECORDING_TIMEOUT,
  )

  it(
    'the changes: updates for closed orders from before the boundary, full Orders for open ones and for those placed after it, the trash, a plugin\'s status',
    () =>
      withOrdersScenario('orders-changes', async (scenario) => {
        const feed = feedOf(scenario, { pageSize: 100, holdBackSeconds: 0 })
        expect((await feed.startAtChanges()).boundary).toBe(57)
        // The ids a fresh shop of the pinned version gives the three orders placed below.
        const placed = { paid: 58, shipped: 59, trashed: 60 }
        const quiet = feed.cursor
        expect(await feed.page()).toEqual({ items: [], nextCursor: quiet, hasMore: false })

        await scenario.change(async (sandbox) => {
          // From before the boundary, closing: on hold → cancelled, processing → completed.
          await sandbox.put('orders/51', { status: 'cancelled' })
          await sandbox.put('orders/54', { status: 'completed' })
          // From before the boundary, still open: a note is added.
          await sandbox.put('orders/30', { customer_note: 'Proszę dzwonić przed dostawą.' })
          // Placed after the boundary: paid; paid and shipped at once; cash on delivery and then trashed.
          placed.paid = expectId(await sandbox.post('orders', newOrder({ set_paid: true, line_items: [{ product_id: 19, variation_id: 21, quantity: 1 }, { product_id: 10, quantity: 2 }] })), 58)
          placed.shipped = expectId(await sandbox.post('orders', newOrder({ set_paid: true })), 59)
          await sandbox.put(`orders/${placed.shipped}`, { status: 'completed' })
          placed.trashed = expectId(await sandbox.post('orders', newOrder({ payment_method: 'cod', payment_method_title: 'Za pobraniem', status: 'processing' })), 60)
          await sandbox.trash(`orders/${placed.trashed}`)
          // From before the boundary, into the trash.
          await sandbox.trash('orders/55')
          // Into a status a plugin registered.
          await sandbox.put('orders/56', { status: 'packing' })
          // Closed before the Connection and reopened by an admin: a cancelled one, and a completed one.
          await sandbox.put('orders/35', { status: 'processing' })
          await sandbox.put('orders/34', { status: 'processing' })
          // Orders that do not fit the canonical Order: one closes, one is only touched.
          await sandbox.put('orders/44', { status: 'cancelled' })
          await sandbox.put('orders/45', { customer_note: 'Bez adresu.' })
        })
        await scenario.settle()

        const page = await feed.page()
        expect(page.hasMore).toBe(false)
        const items = new Map(page.items.map((item) => [label(item), item]))
        expect([...items.keys()].sort()).toEqual(
          ['update 51', 'update 54', 'order 30', `order ${placed.paid}`, `order ${placed.shipped}`, `order ${placed.trashed}`, 'update 55', 'order 56', 'order 35', 'update 34', 'update 44'].sort(),
        )
        expect(scenario.requests.slice(-3)).toEqual([
          expect.stringContaining('GET orders?status=any&orderby=modified&per_page=100&modified_after='),
          expect.stringContaining('GET orders?status=trash&orderby=modified&per_page=100&modified_after='),
          'GET products?include=19&per_page=100&_fields=id,sku',
        ])

        // Closed, from before the boundary: facts only.
        expect(factTypes(items.get('update 51'))).toEqual(['cancelled'])
        expect(factTypes(items.get('update 54'))).toEqual(['paid', 'shipped'])
        // Open, from before the boundary: in full.
        expect(factTypes(items.get('order 30'))).toEqual(['paid'])
        // After the boundary: in full, with every fact.
        expect(items.get(`order ${placed.paid}`)).toMatchObject({ payment: 'prepaid', facts: [{ id: `${placed.paid}:paid`, type: 'paid' }] })
        expect((items.get(`order ${placed.paid}`) as Order).lines.map((line) => [line.offerExternalId, line.sku])).toEqual([
          ['19:21', null],
          ['10', 'WOO-MUG-1'],
        ])
        expect(factTypes(items.get(`order ${placed.shipped}`))).toEqual(['paid', 'shipped'])
        // The trash: a cancelled fact, as an update before the boundary and in full after it.
        expect(items.get('update 55')!.facts.at(-1)).toMatchObject({ id: '55:cancelled', type: 'cancelled', note: 'WooCommerce status: trash' })
        expect(items.get(`order ${placed.trashed}`)).toMatchObject({ payment: 'cash_on_delivery', facts: [{ id: `${placed.trashed}:cancelled`, type: 'cancelled', note: 'WooCommerce status: trash' }] })
        // A plugin's status is neither shipped nor cancelled: open, and unpaid as before.
        expect(items.get('order 56')).toMatchObject({ awaitingPayment: true, facts: [] })
        // Reopened after it was cancelled: open, so in full. Reopened after it was completed: WooCommerce keeps
        // `date_completed`, so it is still shipped and only an update.
        expect(factTypes(items.get('order 35'))).toEqual(['paid'])
        expect(factTypes(items.get('update 34'))).toEqual(['paid', 'shipped'])
        // Does not fit: its facts once closed, skipped while open.
        expect(factTypes(items.get('update 44'))).toEqual(['cancelled'])
        expect(scenario.logs).toEqual([
          { message: 'WooCommerce order skipped: it does not fit the canonical Order', fields: { orderId: 45, problems: ['buyer.name', 'shippingAddress'] } },
        ])

        // A full Order comes before an update of the same Order, and no Order comes twice on the page.
        expect(new Set(page.items.map((item) => item.externalId)).size).toBe(page.items.length)
        // Nothing is read twice.
        expect(page.nextCursor).not.toBe(quiet)
        expect(await feed.page()).toEqual({ items: [], nextCursor: page.nextCursor, hasMore: false })
      }),
    RECORDING_TIMEOUT,
  )

  it(
    'an unpaid Order is awaiting payment, and paid through a fact: a bank transfer, a checkout, a failed payment the Buyer repeats',
    () =>
      withOrdersScenario('orders-unpaid-paid', async (scenario) => {
        const feed = feedOf(scenario, { pageSize: 100, holdBackSeconds: 0 })
        await feed.startAtChanges()
        // The ids a fresh shop of the pinned version gives them, after the three of the scenario before.
        const unpaidIds = { transfer: 61, checkout: 62, failed: 63 }

        await scenario.change(async (sandbox) => {
          unpaidIds.transfer = expectId(await sandbox.post('orders', newOrder({ payment_method: 'bacs', payment_method_title: 'Przelew bankowy', status: 'on-hold' })), 61)
          unpaidIds.checkout = expectId(await sandbox.post('orders', newOrder({ status: 'pending' })), 62)
          unpaidIds.failed = expectId(await sandbox.post('orders', newOrder({ status: 'failed' })), 63)
        })
        await scenario.settle()
        const unpaid = await feed.poll()
        const theThree = Object.values(unpaidIds).map((id) => `order ${id}`)
        expect(labels(unpaid)).toEqual(theThree)
        expect(unpaid[0]).toMatchObject({ payment: 'prepaid', awaitingPayment: true, facts: [] })
        expect(unpaid[1]).toMatchObject({ payment: 'prepaid', awaitingPayment: true, facts: [] })
        // A failed payment is a cancellation for now; nothing was paid.
        expect(unpaid[2]).toMatchObject({ awaitingPayment: true, facts: [{ id: `${unpaidIds.failed}:cancelled`, type: 'cancelled', note: 'WooCommerce status: failed' }] })

        await scenario.change(async (sandbox) => {
          for (const id of Object.values(unpaidIds)) await sandbox.put(`orders/${id}`, { status: 'processing' })
        })
        await scenario.settle()
        const paid = await feed.poll()
        expect(labels(paid)).toEqual(theThree)
        for (const order of paid) {
          // Never the flag dropped without the fact.
          expect(order).not.toHaveProperty('awaitingPayment')
          expect(order.facts).toEqual([{ id: `${order.externalId}:paid`, type: 'paid', occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/), note: null }])
        }

        // Back on hold after the payment: WooCommerce keeps `date_paid`, so the Order is not awaiting payment again.
        await scenario.change((sandbox) => sandbox.put(`orders/${unpaidIds.transfer}`, { status: 'on-hold' }))
        await scenario.settle()
        const held = await feed.poll()
        expect(labels(held)).toEqual([`order ${unpaidIds.transfer}`])
        expect(held[0]).not.toHaveProperty('awaitingPayment')
        expect(held[0]!.facts).toEqual(paid[0]!.facts)
      }),
    RECORDING_TIMEOUT,
  )

  it(
    'a page that ends inside a second, and a second that fills a page: each order once, also when one is saved again between two pages',
    () =>
      withOrdersScenario('orders-changes-one-second', async (scenario) => {
        const feed = feedOf(scenario, { pageSize: 3, holdBackSeconds: 0 })
        await feed.startAtChanges()

        // Two orders saved in one second and, as by a bulk action, seven in the next: the script waits for a
        // second to begin before each group. (The old order storage stamps a save with the clock whatever date
        // the order is given, so the two seconds cannot simply be set.)
        const nextSecond = '$t = time(); while (time() === $t) { usleep(10000); }'
        const save = (ids: number[]) => `foreach ([${ids.join(', ')}] as $id) { $o = wc_get_order($id); $o->set_date_modified(time()); $o->save(); }`
        await scenario.change((sandbox) => sandbox.php(`${nextSecond} ${save([32, 33])} ${nextSecond} ${save([39, 40, 41, 42, 43, 49, 53])}`))
        await scenario.settle()

        // The first page holds the two and one of the seven: it ends inside the second of the seven, so only the
        // second before it is taken. The position rests at the end of that one.
        const first = await feed.page()
        expect(labels(first.items)).toEqual(['order 32', 'order 33'])
        expect(first).toMatchObject({ hasMore: true, nextCursor: expect.stringMatching(/^c1:\d+:\d+:\d+:33:2:0$/) })

        // The next page lies inside the second of the seven altogether: nothing of it can be taken by time (before
        // WooCommerce 10.4.0 the rest of the second could come back in any order), so the feed turns to that
        // second alone.
        const turned = await feed.page()
        expect(turned).toMatchObject({ items: [], hasMore: true, nextCursor: expect.stringMatching(/^s1:\d+:\d+:\d+:0:0:0$/) })
        const second = parseCursor(turned.nextCursor!).at.second
        expect(second).toBe(parseCursor(first.nextCursor!).at.second + 1)

        // That second, by id, between the second before it and the one after.
        const byId = await feed.page()
        expect(labels(byId.items)).toEqual(['order 39', 'order 40', 'order 41'])
        expect(byId).toMatchObject({ hasMore: true, nextCursor: `s1:${parseCursor(first.nextCursor!).start}:${parseCursor(first.nextCursor!).boundary}:${second}:41:3:0` })
        const stamp = (at: number) => new Date(at * 1000).toISOString().replace('.000Z', 'Z')
        expect(scenario.requests.slice(-3, -1)).toEqual([
          expect.stringContaining(`GET orders?status=any&orderby=id&per_page=3&modified_after=${stamp(second - 1)}&modified_before=${stamp(second + 1)}&order=asc&_fields=id,status,`),
          expect.stringContaining(`GET orders?status=trash&orderby=id&per_page=3&modified_after=${stamp(second - 1)}&modified_before=${stamp(second + 1)}&order=asc&_fields=id,status,`),
        ])

        // 39 is saved again and leaves the second. By offset alone, the next page would now begin behind 42.
        await scenario.change((sandbox) => sandbox.put('orders/39', { customer_note: 'Jeszcze jedna zmiana.' }))
        const before = scenario.requests.length
        const next = await feed.page()
        expect(labels(next.items)).toEqual(['order 42'])
        const live = scenario.requests.slice(before).filter((request) => request.includes('status=any'))
        // The page behind two skipped ids does not begin with 41, so the second is read from its beginning.
        expect(live).toHaveLength(2)
        expect(live[0]).toContain('&offset=2&')
        expect(live[0]).toContain('orderby=id')
        expect(live[1]).not.toContain('offset')

        const rest = [...(await feed.poll())]
        await scenario.settle()
        rest.push(...(await feed.poll()))
        // Everything else once, and 39 again with its later stamp; then the changes go on by time.
        expect(labels(rest)).toEqual(['order 43', 'order 49', 'order 53', 'order 39'])
        expect(feed.cursor).toMatch(/^c1:/)
      }),
    RECORDING_TIMEOUT,
  )

  // The two below need nothing of the shop's state and can be recorded on their own (`-t 'a key'`).
  it.each([
    ['a key the shop does not know asks for sign-in (401)', 'orders-pull-unauthorized', 'unknown', 'auth_expired'],
    ['a key of a user who may not manage the shop fails for good, without asking for sign-in (403)', 'orders-pull-forbidden', 'noCapability', 'permanent'],
  ] as const)(
    '%s',
    (_, cassette, key, kind) =>
      withOrdersScenario(cassette, async (scenario) => {
        const pullOrders = createWooCommerceConnector().capabilities['orders.pull']!
        // Every phase of the feed, as the key may stop working at any time.
        for (const cursor of [null, 'l1:1791661200:57:0:0:0', 'c1:1791661200:57:1791661200:0:0:0']) {
          const error = await pullOrders(scenario.context(key), cursor).catch((caught: unknown) => caught)
          expect(classifyConnectorError(error).kind, `cursor ${cursor}`).toBe(kind)
          // The status and nothing of the answer.
          expect((error as Error).message).not.toMatch(/woocommerce_rest|Sorry/)
        }
        expect(scenario.requests).toHaveLength(3)
      }),
    RECORDING_TIMEOUT,
  )
})
