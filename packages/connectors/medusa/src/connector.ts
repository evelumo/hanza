import { defineConnector, type ConnectorDefinition } from '@hanza/connector-sdk'
import { pullOffers } from './capabilities/offers-pull'
import { pullOrders } from './capabilities/orders-pull'
import { updateOrderStatus } from './capabilities/orders-update-status'
import { pushStock } from './capabilities/stock-push'
import { medusaConfigSchema, medusaCredentialsSchema } from './settings'

export interface MedusaConnectorOptions {
  /** Variants and orders asked for per request, 1 to 100 (the default). Tests use a small one. */
  pageSize?: number
  /** Journal entries asked for per request, 1 to 500 (the plugin's maximum, and the default). */
  journalPageSize?: number
}

export type MedusaConnector = ConnectorDefinition<typeof medusaConfigSchema, typeof medusaCredentialsSchema>

export const MAX_PAGE_SIZE = 100
export const MAX_JOURNAL_PAGE_SIZE = 500

function isWhole(value: number, max: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= max
}

export function createMedusaConnector(options: MedusaConnectorOptions = {}): MedusaConnector {
  const pageSize = options.pageSize ?? MAX_PAGE_SIZE
  const journalPageSize = options.journalPageSize ?? MAX_JOURNAL_PAGE_SIZE
  if (!isWhole(pageSize, MAX_PAGE_SIZE)) throw new Error(`Medusa connector: pageSize must be a whole number from 1 to ${MAX_PAGE_SIZE}`)
  if (!isWhole(journalPageSize, MAX_JOURNAL_PAGE_SIZE)) {
    throw new Error(`Medusa connector: journalPageSize must be a whole number from 1 to ${MAX_JOURNAL_PAGE_SIZE}`)
  }
  return defineConnector({
    id: 'medusa',
    name: 'Medusa',
    kind: 'shop',
    auth: { type: 'apiKey' },
    configSchema: medusaConfigSchema,
    credentialsSchema: medusaCredentialsSchema,
    // Medusa has no published rate limit; a proxy in front of it may answer 429, which the core honours.
    rateLimits: { connection: { concurrency: 4 } },
    capabilities: {
      'offers.pull': (ctx, cursor) => pullOffers(ctx, cursor, { pageSize }),
      'orders.pull': (ctx, cursor) => pullOrders(ctx, cursor, { pageSize, journalPageSize }),
      'stock.push': (ctx, levels) => pushStock(ctx, levels),
      'orders.updateStatus': (ctx, input) => updateOrderStatus(ctx, input),
    },
  })
}

export const medusaConnector = createMedusaConnector()
