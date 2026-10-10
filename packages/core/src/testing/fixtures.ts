import { randomUUID } from 'node:crypto'
import { defineConnector, type ChannelFact, type Order, type OrderLine } from '@hanza/connector-sdk'
import { z } from 'zod'
import type { Actor } from '../actor'
import { createConnection } from '../connections/connections'
import type { JobRunInfo } from '../jobs'
import type { OrderPhase } from '../orders/phases'
import type { ShipmentInput } from '../shipments/request'
import { TEST_CARRIER_SERVICES } from './carrier'
import type { TestContext } from './context'

// Fixtures for core's own DB tests; not exported from `@hanza/core/testing`.

export const user: Actor = { type: 'user', userId: 'user-1' }

const nothingToPull = async () => ({ items: [], nextCursor: null, hasMore: false })

/**
 * A do-nothing marketplace Channel registered as `fake`, the connector id `createTestConnection` uses.
 * Register it (`useTestContext({ connectors: [testChannel] })`) where a service checks that a Connection
 * is a Channel, or where a test needs status changes to be pushable.
 */
export const testChannel = defineConnector({
  id: 'fake',
  name: 'Test channel',
  kind: 'marketplace',
  auth: { type: 'none' },
  configSchema: z.looseObject({}),
  credentialsSchema: z.looseObject({}),
  capabilities: {
    'offers.pull': nothingToPull,
    'orders.pull': nothingToPull,
    async 'stock.push'() {},
    async 'orders.updateStatus'() {},
  },
})

/** A connector that is not a Channel. */
export const testCourier = defineConnector({
  id: 'test-courier',
  name: 'Test courier',
  kind: 'courier',
  auth: { type: 'none' },
  configSchema: z.object({}),
  credentialsSchema: z.object({}),
  capabilities: {},
})

export async function createTestConnection(ctx: TestContext, organizationId: string, name = 'Test channel'): Promise<string> {
  const { connectionId } = await createConnection(
    ctx,
    organizationId,
    { connectorId: 'fake', name, config: { failMode: 'none' }, credentials: { apiKey: 'secret-api-key' } },
    user,
  )
  return connectionId
}

export function orderLine(externalId: string, overrides: Partial<OrderLine> = {}): OrderLine {
  return {
    externalId,
    offerExternalId: null,
    sku: null,
    name: `Line ${externalId}`,
    quantity: 1,
    unitPrice: { amount: '10.00', currency: 'PLN' },
    ...overrides,
  }
}

export function fact(id: string, type: ChannelFact['type'], occurredAt = '2026-10-02T10:00:00Z'): ChannelFact {
  return { id, type, occurredAt, note: null }
}

export function buildOrder(overrides: Partial<Order> = {}): Order {
  return {
    externalId: `order-${randomUUID()}`,
    placedAt: '2026-10-01T09:00:00Z',
    payment: 'prepaid',
    total: { amount: '10.00', currency: 'PLN' },
    buyer: { name: 'John Test', email: 'john.test@example.com', phone: null, login: 'john_test' },
    shippingAddress: {
      name: 'John Test',
      company: null,
      street: '1 Example Street',
      postalCode: '00-001',
      city: 'Warsaw',
      countryCode: 'PL',
      phone: null,
      taxId: null,
    },
    billingAddress: null,
    lines: [orderLine('l1')],
    facts: [],
    ...overrides,
  }
}

export function uniqueSku(prefix = 'SKU'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`
}

/** A user who is a member of the organization with `role` (Better Auth's `member.role`); returns them as an Actor. */
export async function addMember(ctx: TestContext, organizationId: string, role: string): Promise<Actor> {
  const userId = randomUUID()
  await ctx.db.user.create({ data: { id: userId, name: `User ${userId.slice(0, 8)}`, email: `${userId}@example.org` } })
  await ctx.db.member.create({ data: { id: randomUUID(), organizationId, userId, role, createdAt: new Date() } })
  return { type: 'user', userId }
}

/**
 * The organization's default status of `phase`, for a test that writes an Order's phase directly (a state older code
 * left behind): the composite foreign key needs the phase and a status of it together. The defaults must exist.
 */
export async function defaultStatusId(ctx: TestContext, organizationId: string, phase: OrderPhase): Promise<string> {
  return (await ctx.db.orderStatus.findFirstOrThrow({ where: { organizationId, phase, isDefault: true }, select: { id: true } })).id
}

export const jobRun: JobRunInfo = { attempt: 1, maxAttempts: 5, retriedLater: 0 }

/** A Connection to the test Carrier (`createTestCarrier`), which must be registered under `connectorId`. */
export async function createCarrierConnection(ctx: TestContext, organizationId: string, connectorId = 'test-carrier'): Promise<string> {
  const { connectionId } = await createConnection(ctx, organizationId, { connectorId, name: 'Test carrier', config: {}, credentials: {} }, user)
  return connectionId
}

/** A Shipment to a locker through the test Carrier. */
export function lockerShipment(connectionId: string, overrides: Partial<ShipmentInput> = {}): ShipmentInput {
  return {
    connectionId,
    service: TEST_CARRIER_SERVICES.locker,
    parcel: { preset: 'small' },
    destination: { type: 'pickup_point', pointId: 'KRA010' },
    cashOnDelivery: null,
    ...overrides,
  }
}

/** A Shipment to the Order's own address through the test Carrier. */
export function courierShipment(connectionId: string, overrides: Partial<ShipmentInput> = {}): ShipmentInput {
  return {
    connectionId,
    service: TEST_CARRIER_SERVICES.courier,
    parcel: { lengthMm: 300, widthMm: 200, heightMm: 100, weightGrams: 1500 },
    destination: { type: 'address' },
    cashOnDelivery: null,
    ...overrides,
  }
}

/**
 * Seconds until the Shipment is due (negative when overdue), null when nothing is owed to it. Read on the database's
 * clock, which is the one `nextCheckAt` is written and compared on: the test machine's clock may differ from it.
 */
export async function secondsUntilDue(ctx: TestContext, shipmentId: string): Promise<number | null> {
  const rows = await ctx.db.$queryRaw<Array<{ seconds: number | null }>>`
    SELECT EXTRACT(EPOCH FROM ("nextCheckAt" - now()))::float8 AS "seconds" FROM "shipment" WHERE "id" = ${shipmentId}`
  return rows[0]?.seconds ?? null
}
