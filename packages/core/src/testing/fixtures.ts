import { randomUUID } from 'node:crypto'
import { defineConnector, type ChannelFact, type Order, type OrderLine } from '@hanza/connector-sdk'
import { z } from 'zod'
import type { Actor } from '../actor'
import { createConnection } from '../connections/connections'
import type { TestContext } from './context'

// Fixtures for core's own DB tests; not exported from `@hanza/core/testing`.

export const user: Actor = { type: 'user', userId: 'user-1' }

/**
 * A do-nothing Channel registered as `fake`, the connector id of `createTestConnection`. Register it
 * (`useTestContext({ connectors: [testChannel] })`) where a test needs status changes to be pushable.
 */
export const testChannel = defineConnector({
  id: 'fake',
  name: 'Test channel',
  kind: 'marketplace',
  auth: { type: 'none' },
  configSchema: z.object({}).passthrough(),
  credentialsSchema: z.object({}).passthrough(),
  capabilities: {
    async 'offers.pull'() {
      return { items: [], nextCursor: null, hasMore: false }
    },
    async 'orders.pull'() {
      return { items: [], nextCursor: null, hasMore: false }
    },
    async 'stock.push'() {},
    async 'orders.updateStatus'() {},
  },
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
