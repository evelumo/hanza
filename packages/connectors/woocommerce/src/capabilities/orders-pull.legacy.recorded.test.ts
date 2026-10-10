import type { Order } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { expectId, factTypes, feedOf, label, labels, newOrder } from '../testing/orders-recorded-feed'
import { withOrdersScenario } from '../testing/orders-scenario'

// The Order feed against a shop that keeps its orders the old way, as posts (WooCommerce 11.2.1 with HPOS off): what
// every shop did before WooCommerce 8.2 and many still do. The other recordings are from HPOS. To record again, the
// sandbox has to be seeded with HPOS off, which `sandbox.sh reset` does not do:
//
//   export WOO_SANDBOX_PROJECT=<name> WOO_SANDBOX_PORT=<port>
//   sandbox/sandbox.sh down && sandbox/sandbox.sh up && sandbox/sandbox.sh wp wc hpos disable
//   sandbox/sandbox.sh seed && sandbox/sandbox.sh key
//   HANZA_RECORD_FIXTURES=1 pnpm --filter @hanza/connector-woocommerce exec vitest run src/capabilities/orders-pull.legacy.recorded.test.ts
//
// What is the same there, and what the feed relies on: a date filter with a `Z` is compared as the instant it names
// (WordPress turns it into site time and compares the site-time column), lists are ordered by time and then id,
// `offset` works with the filters, the trash is a status of its own, and a status change, a note and trashing
// stamp `date_modified`. What differs: an edited address, line or meta does not stamp it (HPOS stamps every save),
// which costs nothing, since the feed reports facts; and the lists are ordered by SITE time, which runs backwards
// for an hour when the clocks are set back in autumn (see the connector's notes for what that hour can lose).

const RECORDING_TIMEOUT = 120_000

describe('orders.pull against a recorded shop on the old order storage', () => {
  it(
    'lists the open orders and follows the changes; an order waiting in a plugin\'s status that then completes is never imported',
    () =>
      withOrdersScenario('orders-legacy-storage', async (scenario) => {
        const feed = feedOf(scenario, { pageSize: 5, holdBackSeconds: 0 })
        const pages = await feed.list()
        expect(feed.cursor).toMatch(/^c1:\d{10}:57:\d{10}:0:0:0$/)
        // By creation time (UTC), then id; 44 and 45 do not fit the canonical Order; 47 waits in a plugin's status,
        // `packing`, and is not listed.
        expect(pages.map(labels)).toEqual([
          ['order 57', 'order 30', 'order 31', 'order 32', 'order 33'],
          ['order 39', 'order 40', 'order 41', 'order 42'],
          ['order 43', 'order 49'],
          ['order 50', 'order 51', 'order 52', 'order 53'],
          ['order 54', 'order 55', 'order 56'],
        ])
        const listing = scenario.requests.filter((request) => request.includes('orderby=date'))
        expect(listing[0]).toMatch(/^GET orders\?status=pending,on-hold,processing&orderby=date&per_page=5&order=asc&_fields=id,status,/)
        // 33 was created at 06:30:00 UTC, 08:30 in Warsaw: the filter names the instant, and the shop reads it so.
        expect(listing[1]).toContain('&after=2026-09-21T06:29:59Z&order=asc')
        // 52 and 53 share a second, and the page ended on 53: one entry of that second is skipped, and 53 comes back first.
        expect(listing[4]).toContain('&after=2026-09-21T09:29:59Z&offset=1&order=asc')
        expect(scenario.requests.join('\n')).not.toContain('dates_are_gmt')

        const quiet = feed.cursor
        expect(await feed.page()).toEqual({ items: [], nextCursor: quiet, hasMore: false })

        await scenario.change(async (sandbox) => {
          // THE GAP: the order in the plugin's status completes, with no other change since the Connection started.
          await sandbox.put('orders/47', { status: 'completed' })
          await sandbox.put('orders/51', { status: 'cancelled' })
          await sandbox.trash('orders/55')
          await sandbox.put('orders/30', { customer_note: 'Proszę dzwonić przed dostawą.' })
          expectId(await sandbox.post('orders', newOrder({ set_paid: true })), 58)
          // On this storage an edited address does not stamp `date_modified`: the order does not come back.
          await sandbox.put('orders/31', { billing: { city: 'Sopot' } })
        })
        await scenario.settle()

        const changed = await feed.poll()
        const items = new Map(changed.map((item) => [label(item), item]))
        expect([...items.keys()].sort()).toEqual(['order 30', 'order 58', 'update 47', 'update 51', 'update 55'])
        // 47 was never listed, so this is an update for an Order Hanza does not have: the core ignores it.
        expect(factTypes(items.get('update 47'))).toEqual(['paid', 'shipped'])
        expect(factTypes(items.get('update 51'))).toEqual(['cancelled'])
        expect(items.get('update 55')!.facts.at(-1)).toMatchObject({ id: '55:cancelled', type: 'cancelled', note: 'WooCommerce status: trash' })
        expect(factTypes(items.get('order 30'))).toEqual(['paid'])
        expect(items.get('order 58') as Order).toMatchObject({ payment: 'prepaid', facts: [{ id: '58:paid', type: 'paid' }] })
        const changes = scenario.requests.filter((request) => request.includes('orderby=modified'))
        expect(changes.at(-2)).toMatch(/^GET orders\?status=any&orderby=modified&per_page=5&modified_after=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z(&offset=\d+)?&order=asc&_fields=id,status,/)
        expect(changes.at(-1)).toMatch(/^GET orders\?status=trash&orderby=modified&per_page=5&modified_after=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z(&offset=\d+)?&order=asc&_fields=id,status,/)

        expect(await feed.page()).toEqual({ items: [], nextCursor: feed.cursor, hasMore: false })
      }),
    RECORDING_TIMEOUT,
  )
})
