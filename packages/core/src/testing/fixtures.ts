import { randomUUID } from 'node:crypto'
import { defineConnector, type ChannelFact, type Order, type OrderLine } from '@hanza/connector-sdk'
import { z } from 'zod'
import type { Actor } from '../actor'
import { createConnection } from '../connections/connections'
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
