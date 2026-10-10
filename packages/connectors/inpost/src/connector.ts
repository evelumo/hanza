import { defineConnector } from '@hanza/connector-sdk'
import { createShipment } from './capabilities/shipments-create'
import { shipmentLabel } from './capabilities/shipments-label'
import { trackShipments } from './capabilities/shipments-track'
import { COURIER_SERVICE, inpostConfigSchema, inpostCredentialsSchema, LOCKER_SERVICE } from './config'

/**
 * InPost through its ShipX API: Paczkomat lockers and the InPost courier in Poland. The token is a static one a
 * person generates in the InPost manager, so there is nothing to refresh.
 *
 * No `shipments.cancel`, on purpose: ShipX takes a cancel only in the tenth of a second in which its own purchase
 * runs, and that purchase can write over the cancel it has just confirmed (AGENTS.md, "Why this connector does not
 * cancel").
 */
export const inpostConnector = defineConnector({
  id: 'inpost',
  name: 'InPost',
  kind: 'courier',
  auth: { type: 'apiKey' },
  configSchema: inpostConfigSchema,
  credentialsSchema: inpostCredentialsSchema,
  // An assumption: InPost publishes no limits (the API sits behind Cloudflare). To be confirmed with InPost.
  rateLimits: { connection: { rate: { requests: 60, windowMs: 60_000 }, concurrency: 2 } },
  shipping: {
    services: [
      {
        id: LOCKER_SERVICE,
        name: 'InPost Paczkomat 24/7',
        destination: 'pickup_point',
        parcel: {
          type: 'presets',
          // The ids are ShipX's `parcels.template` values.
          presets: [
            { id: 'small', name: 'A (8 × 38 × 64 cm, up to 25 kg)' },
            { id: 'medium', name: 'B (19 × 38 × 64 cm, up to 25 kg)' },
            { id: 'large', name: 'C (41 × 38 × 64 cm, up to 25 kg)' },
          ],
        },
        cashOnDelivery: true,
      },
      {
        id: COURIER_SERVICE,
        name: 'InPost Kurier Standard',
        destination: 'address',
        parcel: { type: 'dimensions' },
        cashOnDelivery: true,
      },
    ],
  },
  capabilities: {
    'shipments.create': createShipment,
    'shipments.track': trackShipments,
    'shipments.label': shipmentLabel,
  },
})
