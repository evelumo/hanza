import { createFakeChannel, type FakeChannel } from '@hanza/connector-fake'
import { addConnection, coalesceKeys, createProduct, getAvailability, getOrder, jobs, ordersPullRef, type Actor } from '@hanza/core'
import { createTestContext, createTestOrganization, type TestContext } from '@hanza/core/testing'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

const databaseUrl = inject('hanzaTestDatabaseUrl')
const user: Actor = { type: 'user', userId: 'user-1' }

type ChannelOrder = Parameters<FakeChannel['addOrder']>[0]
type ChannelAddress = ChannelOrder['shippingAddress']

const pln = (amount: string) => ({ amount, currency: 'PLN' })
const fact = (id: string, type: 'paid' | 'cancelled' | 'shipped', occurredAt = '2026-10-04T10:00:00Z', note: string | null = null) => ({
  id,
  type,
  occurredAt,
  note,
})

// What an unpaid Order carries before the Channel reveals the delivery address: the Buyer's account address.
const accountAddress: ChannelAddress = {
  name: 'Jane Buyer',
  company: null,
  street: '2 Account Street',
  postalCode: '00-002',
  city: 'Warsaw',
  countryCode: 'PL',
  phone: null,
  taxId: null,
}
const deliveryAddress: ChannelAddress = { ...accountAddress, street: '9 Delivery Lane', postalCode: '30-009', city: 'Krakow' }

function toteOrder(externalId: string, quantity: number, awaitingPayment = false): ChannelOrder {
  return {
    externalId,
    placedAt: '2026-10-04T09:00:00Z',
    payment: 'prepaid',
    ...(awaitingPayment ? { awaitingPayment: true } : {}),
    total: pln((30 * quantity).toFixed(2)),
    buyer: { name: 'Jane Buyer', email: null, phone: null, login: 'jane_buyer' },
    shippingAddress: accountAddress,
    billingAddress: null,
    lines: [{ externalId: 'l1', offerExternalId: 'fake-offer-5', sku: 'FAKE-SKU-5', name: 'Linen tote bag', quantity, unitPrice: pln('30.00') }],
    facts: [],
  }
}

describe.skipIf(!databaseUrl)('Order feed of a journal Channel end to end (real Postgres, in-memory queue, fake Channel)', () => {
  let ctx: TestContext
  let fake: FakeChannel
  let org: string
  let connectionId: string
  let tote: string

  beforeAll(async () => {
    fake = createFakeChannel({ startWithOpenOrders: true })
    ctx = createTestContext({ databaseUrl: databaseUrl!, connectors: [fake.connector] })
    org = await createTestOrganization(ctx.db)
  })

  afterAll(async () => {
    await ctx?.db.$disconnect()
  })

  /** The test database is shared with other test files: run only this organization's jobs. */
  function keepOwnJobs() {
    const own = ctx.queue.waiting.filter((job) => (job.payload as { organizationId?: string }).organizationId === org)
    ctx.queue.waiting.splice(0, ctx.queue.waiting.length, ...own)
  }

  async function drain() {
    keepOwnJobs()
    const result = await ctx.queue.drain(ctx, jobs)
    expect(result.failed).toEqual([])
    expect(ctx.queue.waiting).toEqual([])
  }

  async function pullOrders() {
    await ctx.queue.enqueue(
      ordersPullRef,
      { organizationId: org, connectionId, trigger: 'schedule' },
      { coalesceKey: coalesceKeys.ordersPull(connectionId) },
    )
    await drain()
  }

  const available = async () => (await getAvailability(ctx.db, org, [tote])).get(tote)!

  function lastPushedTote(): number | undefined {
    for (const levels of [...fake.stockPushes].reverse()) {
      const level = levels.find((candidate) => candidate.offerExternalId === 'fake-offer-5')
      if (level) return level.available
    }
    return undefined
  }

  async function importedIds() {
    const orders = await ctx.db.order.findMany({ where: { organizationId: org, connectionId }, orderBy: { externalId: 'asc' } })
    return orders.map((order) => order.externalId)
  }

  async function order(externalId: string) {
    const row = await ctx.db.order.findFirstOrThrow({ where: { organizationId: org, connectionId, externalId } })
    return (await getOrder(ctx, org, row.id))!
  }

  const syncState = () => ctx.db.syncState.findFirstOrThrow({ where: { organizationId: org, connectionId, stream: 'orders_pull' } })

  it('1. a new Connection imports the Orders open on the Channel, never the ones closed before it', async () => {
    tote = (await createProduct(ctx, org, { sku: 'FAKE-SKU-5', name: 'Linen tote bag', stock: 6 }, user)).productId
    // On the Channel before the Connection: the seed (fake-order-2 cancelled), a shipped Order and two unpaid ones.
    fake.addOrder(toteOrder('shipped-before', 4))
    fake.addFact('shipped-before', fact('shipped-before:shipped', 'shipped', '2026-10-03T10:00:00Z'))
    fake.addOrder(toteOrder('unpaid-1', 1, true))
    fake.addOrder(toteOrder('unpaid-2', 2, true))

    connectionId = (
      await addConnection(ctx, org, { connectorId: 'fake', name: 'Journal channel', config: { failMode: 'none' }, credentials: { apiKey: 'test' } }, user)
    ).connectionId
    await drain()

    expect(await importedIds()).toEqual(['fake-order-1', 'fake-order-3', 'fake-order-4', 'unpaid-1', 'unpaid-2'])
    // The shipped Order consumed nothing: Stock is what the seller counted.
    expect(await available()).toEqual({ stock: 6, reserved: 3, available: 3 })
    expect(lastPushedTote()).toBe(3)
    expect((await syncState()).cursor).toBe('e:9:9')
  })

  it('2. an Order update pays an unpaid Order and gives it the delivery address, sealed', async () => {
    fake.updateOrder('unpaid-1', { facts: [fact('unpaid-1:paid', 'paid')], shippingAddress: deliveryAddress })
    await pullOrders()

    const paid = await order('unpaid-1')
    expect(paid).toMatchObject({ phase: 'new', awaitingPayment: false, shippingAddress: deliveryAddress, buyer: { name: 'Jane Buyer' } })
    const events = await ctx.db.eventLog.findMany({ where: { organizationId: org, subjectId: paid.id }, orderBy: { id: 'asc' } })
    expect(events.map((event) => event.type)).toEqual([
      'order.imported',
      'order.channel_fact_recorded',
      'order.payment_received',
      'order.addresses_updated',
    ])
    const row = await ctx.db.order.findFirstOrThrow({ where: { id: paid.id } })
    expect(JSON.stringify([row, events])).not.toContain('Delivery Lane')
    expect(await available()).toEqual({ stock: 6, reserved: 3, available: 3 })
  })

  it('3. an Order removed on the Channel (merged purchase) is cancelled and its Reservation released', async () => {
    fake.removeOrder('unpaid-2', fact('unpaid-2:removed', 'cancelled', '2026-10-04T11:00:00Z', 'Merged into another order on the Channel'))
    await pullOrders()

    expect(await order('unpaid-2')).toMatchObject({ phase: 'cancelled', awaitingPayment: true })
    expect(await available()).toEqual({ stock: 6, reserved: 1, available: 5 })
    expect(lastPushedTote()).toBe(5)
  })

  it('4. an update for an Order Hanza never had is ignored, and the page goes on', async () => {
    const before = await ctx.db.eventLog.count({ where: { organizationId: org } })
    fake.updateOrder('shipped-before', { facts: [fact('shipped-before:returned', 'cancelled')] })
    fake.addOrder(toteOrder('after-update', 1))
    await pullOrders()

    expect(await importedIds()).toEqual(['after-update', 'fake-order-1', 'fake-order-3', 'fake-order-4', 'unpaid-1', 'unpaid-2'])
    expect((await syncState()).lastResult).toEqual({ pulled: 2, imported: 1, factsApplied: 0, pages: 1, updatesIgnored: 1 })
    const events = await ctx.db.eventLog.findMany({ where: { organizationId: org }, orderBy: { id: 'asc' }, skip: before })
    // Only the new Order left a trace; the ignored update recorded nothing.
    expect(events.filter((event) => event.subjectType === 'order').map((event) => event.type)).toEqual(['order.imported'])
    expect(await available()).toEqual({ stock: 6, reserved: 2, available: 4 })
  })

  it('4b. a later change on an Order closed before the Connection never imports it, so its Stock is not consumed again', async () => {
    // The Channel journals something new about the shipped Order (here: its payment is booked); the connector must not
    // send it as a full Order with its shipped fact.
    fake.addFact('shipped-before', fact('shipped-before:paid', 'paid', '2026-10-04T12:00:00Z'))
    await pullOrders()

    expect(await ctx.db.order.count({ where: { organizationId: org, externalId: 'shipped-before' } })).toBe(0)
    expect(await available()).toEqual({ stock: 6, reserved: 2, available: 4 })
    expect((await syncState()).lastResult).toMatchObject({ pulled: 1, imported: 0, updatesIgnored: 1 })
  })

  it('5. a cursor the Channel forgot restarts the feed from the open Orders, with an Event', async () => {
    // While Hanza is stopped: one Order is placed and closed, another is placed and stays open; then the journal moves on.
    fake.addOrder(toteOrder('gap-closed', 1))
    fake.addFact('gap-closed', fact('gap-closed:cancelled', 'cancelled'))
    fake.addOrder(toteOrder('gap-open', 2))
    fake.forgetJournal()
    const ordersBefore = await ctx.db.order.count({ where: { organizationId: org } })
    await pullOrders()

    const restarts = await ctx.db.eventLog.findMany({ where: { organizationId: org, type: 'connection.order_feed_restarted' } })
    expect(restarts.map((event) => [event.subjectType, event.subjectId])).toEqual([['connection', connectionId]])
    // The open ones are listed again (harmless), the gap's open Order arrives, its closed one never does.
    expect(await ctx.db.order.count({ where: { organizationId: org } })).toBe(ordersBefore + 1)
    expect(await order('gap-open')).toMatchObject({ phase: 'new' })
    expect(await ctx.db.order.count({ where: { organizationId: org, externalId: 'gap-closed' } })).toBe(0)
    expect(await available()).toEqual({ stock: 6, reserved: 4, available: 2 })

    const state = await syncState()
    expect(state).toMatchObject({ cursor: 'e:17:17', lastErrorKind: null, lastResult: expect.objectContaining({ imported: 1, feedRestarts: 1 }) })
    expect((await ctx.db.connection.findFirstOrThrow({ where: { id: connectionId } })).health).toBe('ok')

    // Back to normal: the next pull follows the journal, with no second restart.
    fake.addOrder(toteOrder('after-restart', 1))
    await pullOrders()
    expect(await order('after-restart')).toMatchObject({ phase: 'new' })
    expect(await ctx.db.eventLog.count({ where: { organizationId: org, type: 'connection.order_feed_restarted' } })).toBe(1)
  })
})
