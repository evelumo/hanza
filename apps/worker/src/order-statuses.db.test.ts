import { randomUUID } from 'node:crypto'
import { createFakeChannel, type FakeChannel } from '@hanza/connector-fake'
import {
  addConnection,
  changeOrderStatus,
  coalesceKeys,
  createOrderStatus,
  createProduct,
  getAvailability,
  getOrder,
  jobs,
  ordersPullRef,
  setStatusMapping,
  syncTickRef,
  type Actor,
} from '@hanza/core'
import { createTestContext, createTestOrganization, type TestContext } from '@hanza/core/testing'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

const databaseUrl = inject('hanzaTestDatabaseUrl')

// The engine end to end with organization-defined Order statuses (issue #1, ADR 0014): the core works on phases,
// the statuses are labels within them, and the Channel only ever hears about phases.
describe.skipIf(!databaseUrl)('Order statuses end to end (real Postgres, in-memory queue, fake Channel)', () => {
  let ctx: TestContext
  let fake: FakeChannel
  let org: string
  let admin: Actor
  let mapped: string
  let unmapped: string
  const statuses: Record<string, string> = {}
  const products: Record<string, string> = {}

  beforeAll(async () => {
    fake = createFakeChannel()
    ctx = createTestContext({ databaseUrl: databaseUrl!, connectors: [fake.connector] })
    org = await createTestOrganization(ctx.db)
    const userId = randomUUID()
    await ctx.db.user.create({ data: { id: userId, name: 'Owner', email: `${userId}@example.org` } })
    await ctx.db.member.create({ data: { id: randomUUID(), organizationId: org, userId, role: 'owner', createdAt: new Date() } })
    admin = { type: 'user', userId }
  })

  afterAll(async () => {
    await ctx?.db.$disconnect()
  })

  async function drain() {
    const result = await ctx.queue.drain(ctx, jobs)
    expect(result.failed).toEqual([])
    return result
  }

  function order(connectionId: string, externalId: string) {
    return ctx.db.order.findFirstOrThrow({
      where: { organizationId: org, connectionId, externalId },
      include: { status: true, lines: { orderBy: { externalId: 'asc' }, include: { reservation: true } } },
    })
  }

  function statusUpdates(orderExternalId: string) {
    return fake.statusUpdates.filter((update) => update.orderExternalId === orderExternalId).map((update) => update.status)
  }

  async function pullOrders(connectionId: string) {
    await ctx.queue.enqueue(ordersPullRef, { organizationId: org, connectionId, trigger: 'schedule' }, { coalesceKey: coalesceKeys.ordersPull(connectionId) })
    await drain()
  }

  async function available(sku: string) {
    return (await getAvailability(ctx.db, org, [products[sku]!])).get(products[sku]!)
  }

  it('1. an organization defines its statuses and maps one Channel; Orders arrive in the mapped or the default status', async () => {
    for (const [phase, name] of [
      ['new', 'To verify'],
      ['processing', 'Waiting for packaging'],
      ['processing', 'Packed'],
      ['cancelled', 'Cancelled by buyer'],
    ] as const) {
      statuses[name] = (await createOrderStatus(ctx, org, { phase, name, color: null }, admin)).statusId
    }
    for (const [sku, stock] of [['FAKE-SKU-1', 10], ['FAKE-SKU-2', 5], ['FAKE-SKU-3', 5]] as const) {
      products[sku] = (await createProduct(ctx, org, { sku, name: sku, stock }, admin)).productId
    }
    const config = { config: { failMode: 'none' }, credentials: { apiKey: 'test' } }
    mapped = (await addConnection(ctx, org, { connectorId: 'fake', name: 'Mapped channel', ...config }, admin)).connectionId
    unmapped = (await addConnection(ctx, org, { connectorId: 'fake', name: 'Unmapped channel', ...config }, admin)).connectionId
    await setStatusMapping(ctx, org, mapped, { new: statuses['To verify']!, cancelled: statuses['Cancelled by buyer']! }, admin)
    await drain()

    const mappedFirst = await order(mapped, 'fake-order-1')
    expect([mappedFirst.phase, mappedFirst.status.name]).toEqual(['new', 'To verify'])
    const mappedCancelled = await order(mapped, 'fake-order-2')
    expect([mappedCancelled.phase, mappedCancelled.status.name]).toEqual(['cancelled', 'Cancelled by buyer'])

    // A Channel without a mapping gets the phase defaults, exactly as before organizations had statuses.
    const plainFirst = await order(unmapped, 'fake-order-1')
    expect([plainFirst.phase, plainFirst.status.name, plainFirst.status.isDefault]).toEqual(['new', null, true])
    const plainCancelled = await order(unmapped, 'fake-order-2')
    expect([plainCancelled.phase, plainCancelled.status.name, plainCancelled.status.isDefault]).toEqual(['cancelled', null, true])
    expect(await available('FAKE-SKU-1')).toEqual({ stock: 10, reserved: 4, available: 6 })
  })

  it('2. a person moves an Order into processing (pushed once), then through two statuses of that phase (nothing pushed, Reservations unchanged)', async () => {
    const first = await order(mapped, 'fake-order-1')
    await changeOrderStatus(ctx, org, first.id, { statusId: statuses['Waiting for packaging']! }, admin)
    await drain()
    expect(statusUpdates('fake-order-1')).toEqual(['processing'])
    const pushed = await order(mapped, 'fake-order-1')
    expect(pushed.statusPushDueAt).toBeNull()

    await changeOrderStatus(ctx, org, first.id, { statusId: statuses.Packed! }, admin)
    await drain()
    const packed = await order(mapped, 'fake-order-1')
    expect([packed.phase, packed.status.name]).toEqual(['processing', 'Packed'])
    expect(packed).toMatchObject({ statusPushSeq: pushed.statusPushSeq, statusPushDueAt: null })
    expect(packed.lines.map((line) => [line.reservation?.status, line.reservation?.units])).toEqual([['open', 2]])
    expect(await available('FAKE-SKU-1')).toEqual({ stock: 10, reserved: 4, available: 6 })

    // The sweep has nothing to send either.
    await ctx.db.$executeRaw`UPDATE "order" SET "statusPushDueAt" = now() - interval '1 second' WHERE "organizationId" = ${org} AND "statusPushDueAt" IS NOT NULL`
    await ctx.queue.enqueue(syncTickRef, {})
    await drain()
    expect(statusUpdates('fake-order-1')).toEqual(['processing'])
  })

  it('3. shipping it consumes the Stock and tells the Channel once, through the pending push of #29', async () => {
    const first = await order(mapped, 'fake-order-1')
    await changeOrderStatus(ctx, org, first.id, 'shipped', admin)
    expect((await order(mapped, 'fake-order-1')).statusPushDueAt).not.toBeNull()
    await drain()

    const shipped = await order(mapped, 'fake-order-1')
    expect([shipped.phase, shipped.status.isDefault, shipped.statusPushDueAt]).toEqual(['shipped', true, null])
    expect(shipped.lines[0]?.reservation?.status).toBe('consumed')
    expect(await available('FAKE-SKU-1')).toEqual({ stock: 8, reserved: 2, available: 6 })
    expect(statusUpdates('fake-order-1')).toEqual(['processing', 'shipped'])

    await ctx.db.$executeRaw`UPDATE "order" SET "statusPushDueAt" = now() - interval '1 second' WHERE "organizationId" = ${org} AND "statusPushDueAt" IS NOT NULL`
    await ctx.queue.enqueue(syncTickRef, {})
    await drain()
    expect(statusUpdates('fake-order-1')).toEqual(['processing', 'shipped'])

    const history = (await getOrder(ctx, org, first.id))!.events.filter((event) => event.type === 'order.status_changed').reverse()
    expect(history.map((event) => [event.payload.from, event.payload.to, (event.payload.toStatus as { name: string | null }).name])).toEqual([
      ['new', 'processing', 'Waiting for packaging'],
      ['processing', 'processing', 'Packed'],
      ['processing', 'shipped', null],
    ])
  })

  it('4. a cancellation reported by the Channel lands on the mapped cancelled status, releases the Reservation and is not pushed back', async () => {
    const address = { name: 'Anna Example', company: null, street: '1 Test Street', postalCode: '00-001', city: 'Warsaw', countryCode: 'PL', phone: null, taxId: null }
    fake.addOrder({
      externalId: 'fake-order-5',
      placedAt: '2026-10-03T09:00:00Z',
      payment: 'prepaid',
      total: { amount: '39.99', currency: 'PLN' },
      buyer: { name: 'Anna Example', email: null, phone: null, login: null },
      shippingAddress: address,
      billingAddress: null,
      lines: [{ externalId: 'l1', offerExternalId: 'fake-offer-1', sku: 'FAKE-SKU-1', name: 'Ceramic mug', quantity: 1, unitPrice: { amount: '39.99', currency: 'PLN' } }],
      facts: [],
    })
    await pullOrders(mapped)
    const fifth = await order(mapped, 'fake-order-5')
    expect(fifth.status.name).toBe('To verify')
    await changeOrderStatus(ctx, org, fifth.id, { statusId: statuses.Packed! }, admin)
    await drain()

    fake.addFact('fake-order-5', { id: 'fake-order-5:cancelled', type: 'cancelled', occurredAt: '2026-10-04T10:00:00Z', note: null })
    await pullOrders(mapped)
    const cancelled = await order(mapped, 'fake-order-5')
    expect([cancelled.phase, cancelled.status.name]).toEqual(['cancelled', 'Cancelled by buyer'])
    expect(cancelled.attentionReasons).toEqual(['cancelled_while_processing'])
    expect(cancelled.lines[0]?.reservation?.status).toBe('released')
    expect(statusUpdates('fake-order-5')).toEqual(['processing'])

    await pullOrders(unmapped)
    const plain = await order(unmapped, 'fake-order-5')
    expect([plain.phase, plain.status.name, plain.status.isDefault]).toEqual(['cancelled', null, true])
  })
})
