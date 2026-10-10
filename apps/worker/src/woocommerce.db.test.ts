import { openCassette, withFetch, type OpenedCassette } from '@hanza/connector-sdk/testing'
import { woocommerceConnector } from '@hanza/connector-woocommerce'
import {
  addConnection,
  changeOrderStatus,
  coalesceKeys,
  createProduct,
  getAvailability,
  getChannelAvailability,
  getOffer,
  getOrder,
  jobs,
  linkOffer,
  ordersPullRef,
  PermanentJobError,
  requestSync,
  setStock,
  type Actor,
} from '@hanza/core'
import { createTestContext, createTestOrganization, type TestContext } from '@hanza/core/testing'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
// The connector's package exports no test tooling (its `exports` has "." only), so its scrub config and recording
// setup are reached by path. They must be the connector's own: a second scrub config here would drift from it.
import {
  loadRecording,
  replayConfig,
  replayCredentials,
  unauthorizedCredentials,
  type WooCommerceRecording,
} from '../../../packages/connectors/woocommerce/src/testing/recording'
import { sandboxOf, type Sandbox } from '../../../packages/connectors/woocommerce/src/testing/sandbox'
import { woocommerceScrub } from '../../../packages/connectors/woocommerce/src/testing/scrub'

const databaseUrl = inject('hanzaTestDatabaseUrl')
const user: Actor = { type: 'user', userId: 'user-1' }

// The Order feed reports a change once its second is 20 s old on the shop's clock (the connector's hold-back), so a
// recording waits that out after every change it makes in the shop. A replay never waits: the cassette keeps the
// shop's `Date` header, which is the only clock the feed reads.
const HOLD_BACK_WAIT_MS = 24_000
const RECORDING_TIMEOUT = 180_000

async function openShopCassette(name: string): Promise<{ cassette: OpenedCassette; recording: WooCommerceRecording | null }> {
  let loaded: WooCommerceRecording | null = null
  const cassette = await openCassette(new URL(`./fixtures/${name}.cassette.json`, import.meta.url), {
    scrub: woocommerceScrub,
    // The engine must make exactly the recorded calls: a repeated push would be a bug, not a replay detail.
    match: { exhausted: 'error' },
    secrets: [...Object.values(replayCredentials), ...Object.values(unauthorizedCredentials)],
    recording: async () => (loaded = await loadRecording()),
  })
  // Assigned in a callback, which the compiler does not follow.
  return { cassette, recording: loaded as WooCommerceRecording | null }
}

// The WooCommerce connector under the real sync engine, on a cassette recorded from the connector's sandbox shop
// (WooCommerce 11.2.1, HPOS; the seed is in packages/connectors/woocommerce/sandbox/README.md). To record it again,
// from a fresh shop, since the flow names the seed's ids and changes the shop as it goes:
//
//   export WOO_SANDBOX_PROJECT=<name> WOO_SANDBOX_PORT=<port>
//   packages/connectors/woocommerce/sandbox/sandbox.sh reset
//   HANZA_RECORD_FIXTURES=1 HANZA_TEST_DATABASE_URL=<url> pnpm --filter @hanza/worker exec vitest run src/woocommerce.db.test.ts
//   packages/connectors/woocommerce/sandbox/sandbox.sh down
describe.skipIf(!databaseUrl)('WooCommerce under the sync engine (real Postgres, replayed sandbox shop)', () => {
  let ctx: TestContext
  let cassette: OpenedCassette
  /** The sandbox shop while recording; null on replay. */
  let sandbox: Sandbox | null = null
  let org: string
  let connectionId: string
  const products: Record<string, string> = {}
  /** What the connector sent, as `METHOD path?query` below `wc/v3/`, with the JSON body of a write. */
  const sent: Array<{ request: string; body: unknown }> = []

  // Hanza's Products. `WOO-TSHIRT` is the SKU of a variable product in the shop, which is no Offer; `POSTER-A2` is
  // no SKU of the shop at all.
  const STOCK = {
    'WOO-MUG-1': 20,
    'WOO-NOTE-1': 30,
    'WOO-NOPRICE-1': 3,
    'WOO-BAG-1': 5,
    'WOO-TSHIRT-S': 10,
    'WOO-TSHIRT': 7,
    'WOO-HOODIE-BLK-M': 9,
    'POSTER-A2': 4,
  } as const
  type Sku = keyof typeof STOCK

  beforeAll(async () => {
    const opened = await openShopCassette('woocommerce-engine')
    cassette = opened.cassette
    sandbox = opened.recording === null ? null : sandboxOf(opened.recording)
    // What the connector sent, to assert on pushes without a shop to ask.
    const spy: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      const text = await request.clone().text()
      sent.push({
        request: `${request.method} ${url.pathname.replace('/wp-json/wc/v3/', '')}${decodeURIComponent(url.search)}`,
        body: text === '' ? null : JSON.parse(text),
      })
      return cassette.fetch(request)
    }
    // Answered at the global `fetch`, where the engine's own one ends (its timeout, its request budget and its count
    // of a run's requests), instead of replacing `ctx.fetch`: the engine must see that a status push reached the shop,
    // because it then sends the Order's stock again (ADR 0023). The cassette and the sandbox took theirs before this.
    vi.stubGlobal('fetch', spy)
    ctx = createTestContext({ databaseUrl: databaseUrl!, connectors: [woocommerceConnector] })
    org = await createTestOrganization(ctx.db)
    for (const [sku, stock] of Object.entries(STOCK)) {
      products[sku] = (await createProduct(ctx, org, { sku, name: sku, stock }, user)).productId
    }
    connectionId = (
      await addConnection(
        ctx,
        org,
        { connectorId: 'woocommerce', name: 'Sandbox shop', config: replayConfig, credentials: opened.recording?.credentials ?? replayCredentials },
        user,
      )
    ).connectionId
    // A shop seeded a moment ago would report its own seed as changes.
    await holdBackPasses()
  }, RECORDING_TIMEOUT)

  afterAll(async () => {
    vi.unstubAllGlobals()
    await cassette?.close()
    await ctx?.db.$disconnect()
  })

  /** Recording only: changes the shop behind the recorder's back. Skipped on replay, where the cassette holds what followed. */
  async function inShop(act: (shop: Sandbox) => Promise<void>) {
    if (sandbox !== null) await act(sandbox)
  }

  async function holdBackPasses() {
    if (sandbox !== null) await new Promise((resolve) => setTimeout(resolve, HOLD_BACK_WAIT_MS))
  }

  /**
   * Recording only: the stock the shop itself has for a product, asked behind the recorder's back. It is what a Buyer
   * can order, and the proof that it equals what Hanza says; a replay has no shop to ask.
   */
  async function expectShopStock(productId: number, quantity: number) {
    await inShop(async (shop) => expect((await shop.get(`products/${productId}`)).stock_quantity).toBe(quantity))
  }

  async function drain() {
    const result = await ctx.queue.drain(ctx, jobs)
    expect(result.failed).toEqual([])
    expect(ctx.queue.waiting).toEqual([])
    return result
  }

  async function pullOrders() {
    await ctx.queue.enqueue(ordersPullRef, { organizationId: org, connectionId, trigger: 'schedule' }, { coalesceKey: coalesceKeys.ordersPull(connectionId) })
    await drain()
  }

  const requestsSince = (mark: number) => sent.slice(mark).map((entry) => entry.request)
  /** Every write since `mark`: the request and its body. */
  const writesSince = (mark: number) => sent.slice(mark).filter((entry) => entry.body !== null).map((entry) => [entry.request, entry.body])
  const stockItem = (id: number, quantity: number) => ({ id, manage_stock: true, stock_quantity: quantity })

  const product = (sku: Sku) => products[sku]!
  const skuOf = (productId: string | null) => Object.keys(products).find((sku) => products[sku] === productId) ?? null

  async function availability(sku: Sku) {
    return (await getAvailability(ctx.db, org, [product(sku)])).get(product(sku))
  }

  const offer = (externalId: string) => ctx.db.offer.findFirstOrThrow({ where: { organizationId: org, connectionId, externalId } })

  async function order(externalId: string) {
    const row = await ctx.db.order.findFirstOrThrow({
      where: { organizationId: org, connectionId, externalId },
      include: {
        status: { select: { phase: true, isDefault: true } },
        lines: { include: { reservation: true } },
        facts: { orderBy: [{ occurredAt: 'asc' }, { externalId: 'asc' }] },
      },
    })
    // WooCommerce numbers its order lines, and a text sort would put 10 before 9.
    return { ...row, lines: row.lines.sort((a, b) => Number(a.externalId) - Number(b.externalId)) }
  }

  /** A line as what it was bought as, what it was matched to and what it reserves. */
  async function lines(externalId: string) {
    return (await order(externalId)).lines.map((line) => [
      line.offerExternalId,
      line.sku,
      skuOf(line.productId),
      line.reservation ? `${line.reservation.status} ${line.reservation.units}` : null,
    ])
  }

  const health = async () => (await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId, organizationId: org } })).health
  const syncState = (stream: 'offers_pull' | 'orders_pull' | 'stock_push' | 'order_status_push') =>
    ctx.db.syncState.findFirstOrThrow({ where: { organizationId: org, connectionId, stream } })
  const eventCount = (type: string) => ctx.db.eventLog.count({ where: { organizationId: org, type } })

  /** What must not move when the shop reports something Hanza already knows. */
  async function ledger() {
    const count = { where: { organizationId: org } }
    return {
      orders: await ctx.db.order.count(count),
      lines: await ctx.db.orderLine.count(count),
      facts: await ctx.db.orderChannelFact.count(count),
      events: await ctx.db.eventLog.count(count),
      reservations: (await ctx.db.reservation.groupBy({ by: ['status'], where: { organizationId: org }, _sum: { units: true }, orderBy: { status: 'asc' } })).map(
        (group) => [group.status, group._sum.units],
      ),
      stock: (await ctx.db.stock.aggregate({ where: { organizationId: org }, _sum: { units: true } }))._sum.units,
    }
  }

  it('1. pulls the Offers: simple products and variations, with SKU, publication and the Channel price', async () => {
    // Only the Offers pull: the rest of the first sync waits for the link made by hand in the next step.
    expect(await ctx.queue.drain(ctx, jobs, { maxJobs: 1 })).toEqual({ ran: 1, failed: [] })

    const offers = await ctx.db.offer.findMany({ where: { organizationId: org, connectionId }, orderBy: { id: 'asc' } })
    // Grouped (27) and external (28) products are no Offers, nor are the variable parents 19 and 24.
    expect(offers.map((row) => [row.externalId, row.sku, row.channelStatus, row.channelPriceAmount?.toFixed(2) ?? null, row.channelPriceCurrency])).toEqual([
      ['10', 'WOO-MUG-1', 'active', '49.99', 'PLN'],
      ['11', 'WOO-NOTE-1', 'active', '19.90', 'PLN'],
      ['12', null, 'active', '35.00', 'PLN'],
      ['13', 'WOO-CANDLE-1', 'active', '59.00', 'PLN'],
      // A draft.
      ['14', 'WOO-DRAFT-1', 'inactive', '10.00', 'PLN'],
      ['15', 'WOO-NOPRICE-1', 'active', null, null],
      // On sale: the price a Buyer pays now.
      ['16', 'WOO-BAG-1', 'active', '99.00', 'PLN'],
      ['17', 'WOO-GIFT-100', 'active', '100.00', 'PLN'],
      ['19:20', 'WOO-TSHIRT-S', 'active', '79.00', 'PLN'],
      // No SKU of its own: the shop reports its parent's, `WOO-TSHIRT`, which is no key to link by.
      ['19:21', null, 'active', '79.00', 'PLN'],
      ['19:22', 'WOO-TSHIRT-L', 'active', '79.00', 'PLN'],
      // Disabled in the shop.
      ['19:23', 'WOO-TSHIRT-XL', 'inactive', '89.00', 'PLN'],
      ['24:25', 'WOO-HOODIE-BLK-M', 'active', '159.00', 'PLN'],
      ['24:26', null, 'active', '159.00', 'PLN'],
    ])
    expect(await syncState('offers_pull')).toMatchObject({ lastErrorKind: null, lastResult: { seen: 14, created: 14, updated: 0, linked: 6 } })
    expect(requestsSince(0).map((request) => request.replace(/&_fields=.*$/, ''))).toEqual([
      'GET data/currencies/current?_fields=code',
      'GET products?per_page=100&page=1&orderby=id&order=asc',
      'GET products/19/variations?per_page=100&page=1&orderby=id&order=asc',
      'GET products/24/variations?per_page=100&page=1&orderby=id&order=asc',
    ])
  })

  it('2. links Offers to the Products with their SKU; the variation that reports its parent\'s SKU links to nothing', async () => {
    const offers = await ctx.db.offer.findMany({ where: { organizationId: org, connectionId, productId: { not: null } }, orderBy: { id: 'asc' } })
    expect(offers.map((row) => [row.externalId, skuOf(row.productId), row.linkedBy])).toEqual([
      ['10', 'WOO-MUG-1', 'sku'],
      ['11', 'WOO-NOTE-1', 'sku'],
      ['15', 'WOO-NOPRICE-1', 'sku'],
      ['16', 'WOO-BAG-1', 'sku'],
      ['19:20', 'WOO-TSHIRT-S', 'sku'],
      ['24:25', 'WOO-HOODIE-BLK-M', 'sku'],
    ])
    // Hanza has a Product with the variable parent's SKU, and no Offer took it: not 19:21, which reports that SKU.
    expect(await ctx.db.offer.count({ where: { organizationId: org, productId: product('WOO-TSHIRT') } })).toBe(0)
    expect((await offer('19:21')).productId).toBeNull()

    // The poster has no SKU in the shop, so a person links its Offer: its Order lines can then match by Offer only.
    await linkOffer(ctx, org, (await offer('12')).id, product('POSTER-A2'), user)
    expect(await offer('12')).toMatchObject({ productId: product('POSTER-A2'), linkedBy: 'manual' })
  })

  it('3. imports the Orders open when the Connection started, and only then tells the shop its Stock', async () => {
    // Nothing was written to the shop so far: the Offers are linked, and their stock waits for the Orders (ADR 0023).
    expect(writesSince(0)).toEqual([])
    const mark = sent.length
    await drain()
    expect(await health()).toBe('ok')

    // Open in the shop: `pending`, `on-hold`, `processing`. Not imported: 34 and 48 (completed), 35 (cancelled),
    // 36 (refunded), 38 (failed), 46 (a checkout draft), 47 (a plugin's status), and 44 and 45, which are open but
    // have no lines and no address.
    const imported = await ctx.db.order.findMany({
      where: { organizationId: org, connectionId },
      include: { status: { select: { phase: true, isDefault: true } }, facts: { select: { externalId: true, type: true } } },
    })
    const paid = (id: string) => [{ externalId: `${id}:paid`, type: 'paid' }]
    expect(
      imported
        .sort((a, b) => Number(a.externalId) - Number(b.externalId))
        .map((row) => [row.externalId, row.payment, row.awaitingPayment, row.facts, row.attentionReasons]),
    ).toEqual([
      ['30', 'prepaid', false, paid('30'), []],
      ['31', 'cash_on_delivery', false, [], []],
      // A bank transfer that has not arrived, and a checkout nobody paid for.
      ['32', 'prepaid', true, [], []],
      ['33', 'prepaid', true, [], []],
      ['39', 'prepaid', false, paid('39'), ['unmatched_line']],
      ['40', 'prepaid', false, paid('40'), ['unmatched_line']],
      ['41', 'prepaid', false, paid('41'), []],
      ['42', 'prepaid', true, [], ['unmatched_line']],
      ['43', 'prepaid', false, paid('43'), ['unmatched_line']],
      // Paid, then put on hold by the seller: the payment stays a fact.
      ['49', 'prepaid', false, paid('49'), []],
      ['50', 'prepaid', false, paid('50'), []],
      ['51', 'prepaid', true, [], []],
      ['52', 'prepaid', true, [], ['unmatched_line']],
      ['53', 'cash_on_delivery', false, [], ['unmatched_line']],
      ['54', 'prepaid', false, paid('54'), ['unmatched_line']],
      ['55', 'prepaid', true, [], []],
      ['56', 'prepaid', true, [], []],
      ['57', 'prepaid', false, paid('57'), []],
    ])
    // WooCommerce's `processing` is a paid order waiting to be fulfilled: a new Order for Hanza, in the
    // organization's default status of that phase.
    expect(imported.map((row) => [row.phase, row.status])).toEqual(imported.map(() => ['new', { phase: 'new', isDefault: true }]))
    // Placed at 08:00 in Warsaw and paid two minutes later; a mug at 49.99 with tax, and the courier.
    const first = await order('30')
    expect(first).toMatchObject({ placedAt: new Date('2026-09-21T06:00:00Z'), currency: 'PLN' })
    expect([first.totalAmount.toFixed(2), first.lines[0]?.unitPriceAmount.toFixed(2)]).toEqual(['64.98', '49.99'])
    expect(first.facts.map((fact) => [fact.externalId, fact.occurredAt])).toEqual([['30:paid', new Date('2026-09-21T06:02:00Z')]])

    // What was bought, what Hanza matched it to, and what it reserves.
    expect(await lines('39')).toEqual([
      ['19:20', 'WOO-TSHIRT-S', 'WOO-TSHIRT-S', 'open 2'],
      // The line of the variation without a SKU carries no SKU either, so the Product `WOO-TSHIRT` is not reserved.
      ['19:21', null, null, null],
      ['10', 'WOO-MUG-1', 'WOO-MUG-1', 'open 3'],
      // Matched through its Offer alone: the line has no SKU and the Product another one.
      ['12', null, 'POSTER-A2', 'open 1'],
    ])
    // The product of the first line was deleted in the shop.
    expect(await lines('43')).toEqual([
      [null, null, null, null],
      ['10', 'WOO-MUG-1', 'WOO-MUG-1', 'open 1'],
    ])
    expect(await lines('41')).toEqual([['24:25', 'WOO-HOODIE-BLK-M', 'WOO-HOODIE-BLK-M', 'open 1']])
    // An Offer nobody linked, with a SKU no Product has.
    expect(await lines('52')).toEqual([['19:22', 'WOO-TSHIRT-L', null, null]])
    // An Order awaiting payment reserves like any other (ADR 0015).
    expect(await lines('55')).toEqual([['11', 'WOO-NOTE-1', 'WOO-NOTE-1', 'open 5']])

    // Mugs: 30, 32, 39 (3), 43, 51 (2), 57. Notebooks: 31 (2), 32, 49, 50, 55 (5). Backpacks: 33, 56.
    expect(await availability('WOO-MUG-1')).toEqual({ stock: 20, reserved: 9, available: 11 })
    expect(await availability('WOO-NOTE-1')).toEqual({ stock: 30, reserved: 10, available: 20 })
    expect(await availability('WOO-BAG-1')).toEqual({ stock: 5, reserved: 2, available: 3 })
    expect(await availability('WOO-TSHIRT-S')).toEqual({ stock: 10, reserved: 2, available: 8 })
    expect(await availability('WOO-HOODIE-BLK-M')).toEqual({ stock: 9, reserved: 1, available: 8 })
    expect(await availability('POSTER-A2')).toEqual({ stock: 4, reserved: 1, available: 3 })
    expect(await availability('WOO-NOPRICE-1')).toEqual({ stock: 3, reserved: 0, available: 3 })
    expect(await availability('WOO-TSHIRT')).toEqual({ stock: 7, reserved: 0, available: 7 })

    // The feed took its start, listed the open orders in one page and went on to the changes, where it stays.
    const feed = await syncState('orders_pull')
    expect(feed.cursor).toMatch(/^c1:\d{10}:57:\d{10}:0:0:0$/)
    expect(feed).toMatchObject({ lastErrorKind: null, lastResult: { pulled: 18, imported: 18, factsApplied: 9, pages: 3 } })

    const requests = requestsSince(mark).map((request) => request.replace(/&_fields=id,status,.*$/, ''))
    expect(requests).toEqual([
      // The stock push that came with the sync ran first and sent nothing: the Order feed was not read yet, and the
      // shop's own numbers, which already count its open orders, stay until Hanza knows those orders too.
      'GET orders?status=any&orderby=id&order=desc&per_page=1&_fields=id',
      'GET orders?status=trash&orderby=id&order=desc&per_page=1&_fields=id',
      'GET orders?status=pending,on-hold,processing&orderby=date&per_page=100&order=asc',
      // Which SKUs the variation lines of the page inherit.
      'GET products?include=19,24&per_page=100&_fields=id,sku',
      expect.stringMatching(/^GET orders\?status=any&orderby=modified&per_page=100&modified_after=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ&order=asc$/),
      expect.stringMatching(/^GET orders\?status=trash&orderby=modified&per_page=100&modified_after=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ&order=asc$/),
      // The first push, once the feed was read to its end: every linked Offer with what the Reservations of the
      // shop's open Orders leave. The simple products are read first, so that a number is never set on a product
      // that has become something else.
      'GET products?include=10,11,12,15,16&per_page=100&_fields=id,type',
      'POST products/batch',
      'POST products/19/variations/batch',
      'POST products/24/variations/batch',
    ])
    // The shop is never told 20 mugs, the Stock without its own nine open ones.
    expect(writesSince(mark)).toEqual([
      ['POST products/batch', { update: [stockItem(10, 11), stockItem(11, 20), stockItem(12, 3), stockItem(15, 3), stockItem(16, 3)] }],
      ['POST products/19/variations/batch', { update: [stockItem(20, 8)] }],
      ['POST products/24/variations/batch', { update: [stockItem(25, 8)] }],
    ])
    expect(await syncState('stock_push')).toMatchObject({ lastErrorKind: null, lastResult: { pushed: 7, rejected: 0, skipped: 0 } })
    expect(await offer('10')).toMatchObject({ lastPushedAvailable: 11, stockRejectedCode: null })
    await expectShopStock(10, 11)
  })

  it('4. seals the Buyer data of every Order: nothing personal in a column or an Event', async () => {
    const rows = await ctx.db.$queryRaw<Array<{ id: string; row: Record<string, unknown> }>>`
      SELECT o."id", row_to_json(o) AS "row" FROM "order" o WHERE o."organizationId" = ${org}`
    expect(rows).toHaveLength(18)
    const personal = new Set<string>()
    for (const { id, row } of rows) {
      expect(row).toMatchObject({ buyerName: null, buyerEmail: null, buyerPhone: null, buyerLogin: null, shippingAddress: null, billingAddress: null })
      expect(row.buyerData).toEqual(expect.any(String))
      // Read back through the core, the way the panel does.
      const detail = await getOrder(ctx, org, id)
      const { buyer, shippingAddress, billingAddress } = detail!
      expect(buyer?.name).toBeTruthy()
      for (const value of [buyer?.name, buyer?.email, buyer?.phone, shippingAddress?.name, shippingAddress?.street, billingAddress?.street]) {
        if (value) personal.add(value)
      }
    }
    // Several Buyers, a recipient who is not the Buyer, and addresses of their own.
    expect(personal.size).toBeGreaterThan(10)

    const stored = JSON.stringify([
      rows,
      await ctx.db.orderLine.findMany({ where: { organizationId: org } }),
      await ctx.db.orderChannelFact.findMany({ where: { organizationId: org } }),
      await ctx.db.eventLog.findMany({ where: { organizationId: org } }),
    ])
    for (const value of personal) expect(stored).not.toContain(value)
    // The destination country is the one thing kept in the clear: accounting needs it after an erasure (ADR 0016).
    expect((await order('41')).shippingCountryCode).toBe('DE')
  })

  it('5. a second pull with nothing new imports nothing and adds no Events', async () => {
    const before = await ledger()
    const { cursor } = await syncState('orders_pull')
    const mark = sent.length
    await pullOrders()

    expect(await ledger()).toEqual(before)
    expect(await syncState('orders_pull')).toMatchObject({ cursor, lastResult: { pulled: 0, imported: 0, factsApplied: 0, pages: 1 } })
    // The two lists of changes, and no push: nothing moved.
    expect(requestsSince(mark)).toHaveLength(2)
  })

  it('6. a second sync of the whole Connection relinks nothing and pushes nothing', async () => {
    const before = await ledger()
    const linked = await ctx.db.offer.count({ where: { organizationId: org, connectionId, productId: { not: null } } })
    const mark = sent.length
    await requestSync(ctx, org, connectionId)
    await drain()

    expect(await syncState('offers_pull')).toMatchObject({ lastErrorKind: null, lastResult: { seen: 14, created: 0, updated: 14, linked: 0 } })
    expect(await ctx.db.offer.count({ where: { organizationId: org, connectionId, productId: { not: null } } })).toBe(linked)
    // The link made by hand is not undone by a pull that finds no SKU on the Offer.
    expect(await offer('12')).toMatchObject({ productId: product('POSTER-A2'), linkedBy: 'manual' })
    expect(await ledger()).toEqual(before)
    // The currency, the products, the variations of the two variable ones, and the two lists of changed orders.
    expect(requestsSince(mark)).toHaveLength(6)
    expect(writesSince(mark)).toEqual([])
  })

  it(
    '7. changes in the shop: a payment ends the wait, a cancellation and the trash release, a completion consumes Stock',
    async () => {
      await inShop(async (shop) => {
        await shop.put('orders/33', { set_paid: true })
        await shop.put('orders/51', { status: 'cancelled' })
        await shop.trash('orders/55')
        await shop.put('orders/30', { status: 'completed' })
      })
      await holdBackPasses()
      const mark = sent.length
      await pullOrders()

      // 33 is still open and comes whole; the three closed ones come as their facts alone.
      expect(await syncState('orders_pull')).toMatchObject({ lastResult: { pulled: 4, imported: 0, factsApplied: 4, pages: 1 } })

      const paid = await order('33')
      expect(paid).toMatchObject({ phase: 'new', awaitingPayment: false, attentionReasons: [] })
      expect(paid.facts.map((fact) => fact.externalId)).toEqual(['33:paid'])
      expect(await lines('33')).toEqual([['16', 'WOO-BAG-1', 'WOO-BAG-1', 'open 1']])

      const cancelled = await order('51')
      expect(cancelled).toMatchObject({ phase: 'cancelled', status: { phase: 'cancelled', isDefault: true }, attentionReasons: [] })
      expect(cancelled.facts.map((fact) => [fact.externalId, fact.note])).toEqual([['51:cancelled', 'WooCommerce status: cancelled']])
      expect(await lines('51')).toEqual([['10', 'WOO-MUG-1', 'WOO-MUG-1', 'released 2']])

      const trashed = await order('55')
      expect(trashed).toMatchObject({ phase: 'cancelled', attentionReasons: [] })
      expect(trashed.facts.map((fact) => [fact.externalId, fact.note])).toEqual([['55:cancelled', 'WooCommerce status: trash']])
      expect(await lines('55')).toEqual([['11', 'WOO-NOTE-1', 'WOO-NOTE-1', 'released 5']])

      const completed = await order('30')
      expect(completed).toMatchObject({ phase: 'shipped', status: { phase: 'shipped', isDefault: true }, attentionReasons: [] })
      expect(completed.facts.map((fact) => fact.externalId)).toEqual(['30:paid', '30:shipped'])
      expect(await lines('30')).toEqual([['10', 'WOO-MUG-1', 'WOO-MUG-1', 'consumed 1']])

      // One mug left the Warehouse and two were given back; five notebooks were given back.
      expect(await availability('WOO-MUG-1')).toEqual({ stock: 19, reserved: 6, available: 13 })
      expect(await availability('WOO-NOTE-1')).toEqual({ stock: 30, reserved: 5, available: 25 })
      expect(await availability('WOO-BAG-1')).toEqual({ stock: 5, reserved: 2, available: 3 })
      expect(await eventCount('order.payment_received')).toBe(1)

      // The shop is told the new numbers, and never what it reported itself (a Channel fact is not pushed back).
      // The backpack (16) is sent too, with the number it had: Hanza took the unit of the unpaid Order 33 off it
      // when the Order arrived, and WooCommerce took it off its own stock again when the order was paid (3 became 2).
      // The `paid` fact moves no Stock in Hanza, but it marks the Order's Offers, so the shop is back at 3 (ADR 0023).
      expect(writesSince(mark)).toEqual([['POST products/batch', { update: [stockItem(10, 13), stockItem(11, 25), stockItem(16, 3)] }]])
      expect((await getChannelAvailability(ctx.db, org, connectionId, [product('WOO-BAG-1')])).get(product('WOO-BAG-1'))).toBe(3)
      await expectShopStock(16, 3)
      await expectShopStock(10, 13)
      expect(await health()).toBe('ok')
    },
    RECORDING_TIMEOUT,
  )

  it(
    '8. the same Orders reported again change nothing',
    async () => {
      // Any save stamps an order as modified, so the feed reports it again with facts Hanza has.
      await inShop(async (shop) => {
        for (const id of [33, 51, 30]) await shop.put(`orders/${id}`, { customer_note: 'Proszę dzwonić przed dostawą.' })
      })
      await holdBackPasses()
      const before = await ledger()
      const mark = sent.length
      await pullOrders()

      expect(await syncState('orders_pull')).toMatchObject({ lastResult: { pulled: 3, imported: 0, factsApplied: 0, pages: 1 } })
      expect(await ledger()).toEqual(before)
      expect((await order('33')).awaitingPayment).toBe(false)
      expect(await availability('WOO-MUG-1')).toEqual({ stock: 19, reserved: 6, available: 13 })
      expect(writesSince(mark)).toEqual([])
    },
    RECORDING_TIMEOUT,
  )

  it('9. pushes Channel Available after Stock is set; an Offer the shop no longer has is rejected on the Offer alone', async () => {
    // Product 15 goes to the shop's trash.
    await inShop((shop) => shop.trash('products/15'))
    const mark = sent.length
    await setStock(ctx, org, product('WOO-MUG-1'), 50, user)
    await setStock(ctx, org, product('WOO-NOPRICE-1'), 8, user)
    await drain()

    // 50 mugs less the 6 still reserved.
    expect((await getChannelAvailability(ctx.db, org, connectionId, [product('WOO-MUG-1')])).get(product('WOO-MUG-1'))).toBe(44)
    // The shop does not list 15 any more, so only the mug is written.
    expect(requestsSince(mark)).toEqual(['GET products?include=10,15&per_page=100&_fields=id,type', 'POST products/batch'])
    expect(writesSince(mark)).toEqual([['POST products/batch', { update: [stockItem(10, 44)] }]])

    expect(await offer('10')).toMatchObject({ lastPushedAvailable: 44, stockRejectedCode: null })
    const rejected = await offer('15')
    // The number of the first push stays: 8 never reached the shop.
    expect(rejected).toMatchObject({ lastPushedAvailable: 3, stockRejectedCode: 'woocommerce_rest_product_invalid_id' })
    expect(await getOffer(ctx, org, rejected.id)).toMatchObject({ stockStatus: 'rejected', stockRejection: { code: 'woocommerce_rest_product_invalid_id' } })
    const events = await ctx.db.eventLog.findMany({ where: { organizationId: org, type: 'offer.push_rejected' } })
    expect(events.map((event) => [event.subjectId, event.payload])).toEqual([[rejected.id, { push: 'stock', code: 'woocommerce_rest_product_invalid_id' }]])
    expect(await syncState('stock_push')).toMatchObject({ lastErrorKind: null, lastResult: { pushed: 1, rejected: 1, skipped: 0 } })
    expect(await health()).toBe('ok')
  })

  it(
    '10. pushes processing to the shop; the Order coming back through the feed changes nothing',
    async () => {
      // 49 is on hold in the shop, though paid: a status Hanza's `processing` moves on from.
      const { id } = await order('49')
      const mark = sent.length
      await changeOrderStatus(ctx, org, id, 'processing', user)
      await drain()
      // The status reached the shop, which may have moved its own count with it: the Order's Offer (the notebook) is
      // told its number again. Nothing changed it here, so the same 25.
      expect(requestsSince(mark)).toEqual([
        'GET orders/49?_fields=id,status',
        'PUT orders/49?_fields=id,status',
        'GET products?include=11&per_page=100&_fields=id,type',
        'POST products/batch',
      ])
      expect(writesSince(mark)).toEqual([
        ['PUT orders/49?_fields=id,status', { status: 'processing' }],
        ['POST products/batch', { update: [stockItem(11, 25)] }],
      ])
      expect(await order('49')).toMatchObject({ phase: 'processing', statusPushDueAt: null })
      expect(await syncState('order_status_push')).toMatchObject({ lastErrorKind: null, lastResult: { pushed: 1 } })

      // The shop stamped the order as modified, so the feed reports it: open, and in full.
      await holdBackPasses()
      const before = await ledger()
      await pullOrders()
      expect(await syncState('orders_pull')).toMatchObject({ lastResult: { pulled: 1, imported: 0, factsApplied: 0, pages: 1 } })
      expect(await ledger()).toEqual(before)
      expect(await order('49')).toMatchObject({ phase: 'processing', attentionReasons: [] })
      // It brings no new fact, so nothing more is written.
      expect(writesSince(mark)).toHaveLength(2)
    },
    RECORDING_TIMEOUT,
  )

  it(
    '11. pushes shipped and cancelled to the shop; the Orders coming back as facts change nothing and need nobody',
    async () => {
      let mark = sent.length
      await changeOrderStatus(ctx, org, (await order('49')).id, 'shipped', user)
      await drain()
      expect(writesSince(mark)).toEqual([
        // The notebook left the Warehouse and its Reservation with it: the same number, sent again.
        ['POST products/batch', { update: [stockItem(11, 25)] }],
        ['PUT orders/49?_fields=id,status', { status: 'completed' }],
        // And once more after the status reached the shop.
        ['POST products/batch', { update: [stockItem(11, 25)] }],
      ])
      await expectShopStock(11, 25)
      expect(await lines('49')).toEqual([['11', 'WOO-NOTE-1', 'WOO-NOTE-1', 'consumed 1']])
      expect(await availability('WOO-NOTE-1')).toEqual({ stock: 29, reserved: 4, available: 25 })

      // 57 is paid and `processing` in the shop; a person cancels it in Hanza.
      mark = sent.length
      await changeOrderStatus(ctx, org, (await order('57')).id, 'cancelled', user)
      await drain()
      // The freed mug is pushed (45) before the shop is told of the cancellation, since the two jobs run in the order
      // they were enqueued in, and WooCommerce then puts the unit of a cancelled order back into its own stock on top
      // of that number: 46, one mug that does not exist. The status push that reached the shop marks the Order's
      // Offers, so 45 is sent again and stays (ADR 0023).
      expect(writesSince(mark)).toEqual([
        ['POST products/batch', { update: [stockItem(10, 45)] }],
        ['PUT orders/57?_fields=id,status', { status: 'cancelled' }],
        ['POST products/batch', { update: [stockItem(10, 45)] }],
      ])
      expect(await lines('57')).toEqual([['10', 'WOO-MUG-1', 'WOO-MUG-1', 'released 1']])
      expect(await availability('WOO-MUG-1')).toEqual({ stock: 50, reserved: 5, available: 45 })
      expect((await getChannelAvailability(ctx.db, org, connectionId, [product('WOO-MUG-1')])).get(product('WOO-MUG-1'))).toBe(45)
      await expectShopStock(10, 45)

      // Closed in the shop by Hanza itself, both orders come back as a fact. Hanza records the two facts and changes
      // nothing else: no phase to change, no Stock to move, nothing for a person to look at. A fact it had not
      // recorded is a change in the shop all the same, so their Offers are told their numbers once more.
      await holdBackPasses()
      const before = await ledger()
      mark = sent.length
      await pullOrders()
      expect(await syncState('orders_pull')).toMatchObject({ lastResult: { pulled: 2, imported: 0, factsApplied: 2, pages: 1 } })
      const shipped = await order('49')
      expect(shipped).toMatchObject({ phase: 'shipped', attentionReasons: [], statusPushDueAt: null })
      expect(shipped.facts.map((fact) => fact.externalId)).toEqual(['49:paid', '49:shipped'])
      const cancelled = await order('57')
      expect(cancelled).toMatchObject({ phase: 'cancelled', attentionReasons: [], statusPushDueAt: null })
      expect(cancelled.facts.map((fact) => fact.externalId)).toEqual(['57:paid', '57:cancelled'])
      expect(await ledger()).toEqual({ ...before, facts: before.facts + 2, events: before.events + 2 })
      expect(writesSince(mark)).toEqual([['POST products/batch', { update: [stockItem(10, 45), stockItem(11, 25)] }]])
      await expectShopStock(10, 45)
      await expectShopStock(11, 25)
      expect(await ctx.db.order.count({ where: { organizationId: org, attentionReasons: { has: 'channel_fact_conflict' } } })).toBe(0)
      expect(await health()).toBe('ok')
    },
    RECORDING_TIMEOUT,
  )

  it('served every recorded interaction and nothing else', () => {
    expect(cassette.misses).toEqual([])
    expect(cassette.unused()).toEqual([])
  })
})

describe.skipIf(!databaseUrl)('WooCommerce refusing the key (real Postgres, replayed sandbox shop)', () => {
  let ctx: TestContext
  let cassette: OpenedCassette
  let org: string

  beforeAll(async () => {
    cassette = (await openShopCassette('woocommerce-engine-unauthorized')).cassette
    ctx = createTestContext({ databaseUrl: databaseUrl!, connectors: [withFetch(woocommerceConnector, cassette.fetch)] })
    org = await createTestOrganization(ctx.db)
  })

  afterAll(async () => {
    await cassette?.close()
    await ctx?.db.$disconnect()
  })

  it('a 401 from the shop: the run ends without a retry and the Connection waits for sign-in', async () => {
    // A key the shop does not know, sent as it is also while recording.
    const { connectionId } = await addConnection(
      ctx,
      org,
      { connectorId: 'woocommerce', name: 'Revoked key', config: replayConfig, credentials: unauthorizedCredentials },
      user,
    )
    const result = await ctx.queue.drain(ctx, jobs)

    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]).toMatchObject({ name: 'offers.pull', attempts: 1 })
    expect(result.failed[0]?.error).toBeInstanceOf(PermanentJobError)
    expect(ctx.queue.waiting).toEqual([])
    expect((await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId, organizationId: org } })).health).toBe('auth_expired')
    expect(await ctx.db.syncState.findFirstOrThrow({ where: { organizationId: org, connectionId, stream: 'offers_pull' } })).toMatchObject({
      lastErrorKind: 'auth_expired',
      lastSucceededAt: null,
    })
    const events = await ctx.db.eventLog.findMany({ where: { organizationId: org, type: 'connection.health_changed' } })
    expect(events.map((event) => [event.subjectId, event.payload])).toEqual([[connectionId, { from: 'unknown', to: 'auth_expired', errorKind: 'auth_expired' }]])
    expect(await ctx.db.offer.count({ where: { organizationId: org } })).toBe(0)
    expect(cassette.misses).toEqual([])
    expect(cassette.unused()).toEqual([])
  })
})
