import { randomUUID } from 'node:crypto'
import type { ChannelFact, Order, OrderLine } from '@hanza/connector-sdk'
import type { Actor } from '../actor'
import { createConnection } from '../connections/connections'
import type { TestContext } from './context'

// Fixtures for core's own DB tests; not exported from `@hanza/core/testing`.

export const user: Actor = { type: 'user', userId: 'user-1' }

export async function createTestConnection(ctx: TestContext, organizationId: string, name = 'Kanał testowy'): Promise<string> {
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
    name: `Pozycja ${externalId}`,
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
    buyer: { name: 'Jan Testowy', email: 'jan.testowy@example.com', phone: null, login: 'jan_testowy' },
    shippingAddress: {
      name: 'Jan Testowy',
      company: null,
      street: 'ul. Przykładowa 1',
      postalCode: '00-001',
      city: 'Warszawa',
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
