import { defineConnector } from '@hanza/connector-sdk'
import { allegroAuth } from './auth'
import { pullOffers } from './capabilities/offers-pull'
import { pullOrders } from './capabilities/orders-pull'
import { updateOrderStatus } from './capabilities/orders-update-status'
import { pushPrices } from './capabilities/price-push'
import { pushStock } from './capabilities/stock-push'
import { allegroAppConfigSchema, allegroConfigSchema, allegroCredentialsSchema } from './settings'

/**
 * The Allegro marketplace: Offers and Orders in, Stock, prices and the Order phase out. Signs in through the device
 * flow with the operator's registered application (installation settings `HANZA_CONNECTOR_ALLEGRO_*`).
 */
export const allegroConnector = defineConnector({
  id: 'allegro',
  name: 'Allegro',
  kind: 'marketplace',
  auth: allegroAuth,
  appConfigSchema: allegroAppConfigSchema,
  configSchema: allegroConfigSchema,
  credentialsSchema: allegroCredentialsSchema,
  // Allegro: 9,000 requests a minute per Client ID, and an unpublished leaky bucket per seller.
  rateLimits: {
    application: { requests: 6000, windowMs: 60_000 },
    connection: { concurrency: 3 },
  },
  reopensSoldOutOffers: true,
  capabilities: {
    'offers.pull': pullOffers,
    'orders.pull': pullOrders,
    'stock.push': pushStock,
    'price.push': pushPrices,
    'orders.updateStatus': updateOrderStatus,
  },
})
