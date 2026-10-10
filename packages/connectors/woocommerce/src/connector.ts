import { defineConnector, type ConnectorDefinition } from '@hanza/connector-sdk'
import { pullOffers } from './capabilities/offers-pull'
import { pullOrders } from './capabilities/orders-pull'
import { updateOrderStatus } from './capabilities/orders-update-status'
import { pushStock } from './capabilities/stock-push'
import { configSchema, credentialsSchema } from './settings'

export interface WooCommerceConnectorOptions {
  /** Items asked for per request, 1 to 100 (WooCommerce's maximum, and the default). Tests use a small one. */
  pageSize?: number
  /** How far behind the shop's clock the Order feed reads changes, in seconds. Default 20. */
  holdBackSeconds?: number
}

export type WooCommerceConnector = ConnectorDefinition<typeof configSchema, typeof credentialsSchema>

export const MAX_PAGE_SIZE = 100
export const DEFAULT_HOLD_BACK_SECONDS = 20

export function createWooCommerceConnector(options: WooCommerceConnectorOptions = {}): WooCommerceConnector {
  const pageSize = options.pageSize ?? MAX_PAGE_SIZE
  const holdBackSeconds = options.holdBackSeconds ?? DEFAULT_HOLD_BACK_SECONDS
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new Error(`WooCommerce connector: pageSize must be a whole number from 1 to ${MAX_PAGE_SIZE}`)
  }
  if (!Number.isInteger(holdBackSeconds) || holdBackSeconds < 0) {
    throw new Error('WooCommerce connector: holdBackSeconds must be a whole number, 0 or more')
  }
  return defineConnector({
    id: 'woocommerce',
    name: 'WooCommerce',
    kind: 'shop',
    auth: { type: 'apiKey' },
    configSchema,
    credentialsSchema,
    // WooCommerce has no rate limit of its own, and a declared rate below the connector's natural pace would
    // refuse requests in the middle of a stock push over many variable products, which then starts over.
    rateLimits: { connection: { concurrency: 2 } },
    capabilities: {
      'offers.pull': (ctx, cursor) => pullOffers(ctx, cursor, { pageSize }),
      'orders.pull': (ctx, cursor) => pullOrders(ctx, cursor, { pageSize, holdBackSeconds }),
      'stock.push': (ctx, levels) => pushStock(ctx, levels),
      'orders.updateStatus': (ctx, input) => updateOrderStatus(ctx, input),
    },
  })
}

export const woocommerceConnector = createWooCommerceConnector()
