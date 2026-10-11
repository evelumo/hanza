import { shipmentParcelSchema, shipmentRequestSchema, type ShipmentRequest } from '@hanza/connector-sdk'
import { moneyFromColumns } from '../prices/price'
import { readBuyerData, type StoredBuyerData } from '../privacy/buyer-data'
import type { SecretBox } from '../secrets'
import { openDestination } from './sealed'

/** Why a request cannot be built; becomes the Shipment's `failureCode`. */
export type RequestFailure = 'buyer_data_erased' | 'buyer_data_unreadable' | 'request_invalid'

interface RequestedShipment {
  id: string
  organizationId: string
  service: string
  parcel: unknown
  codAmount: { toFixed(): string } | null
  codCurrency: string | null
  destination: string | null
  createdAt: Date
  order: StoredBuyerData
}

/**
 * What the Carrier is asked for, built in the worker's memory from the Order's sealed Buyer data and the destination a
 * person confirmed. The result holds Buyer data: it goes to the connector and nowhere else, never into a job payload,
 * an Event or a log line (ADR 0016). `reference` and `requestedAt` are the same on every repeat, which is what lets a
 * connector find the Shipment an earlier call made.
 */
export function buildShipmentRequest(secrets: SecretBox, shipment: RequestedShipment): { request: ShipmentRequest } | { failure: RequestFailure } {
  // An Erasure clears the destination with the Buyer data.
  if (shipment.destination === null) return { failure: 'buyer_data_erased' }
  let buyerData
  let confirmed
  try {
    buyerData = readBuyerData(secrets, shipment.order)
    confirmed = openDestination(secrets, { organizationId: shipment.organizationId, shipmentId: shipment.id }, shipment.destination)
  } catch {
    return { failure: 'buyer_data_unreadable' }
  }
  if (buyerData === null) return { failure: 'buyer_data_erased' }

  const { buyer, shippingAddress } = buyerData
  const request = shipmentRequestSchema.safeParse({
    reference: shipment.id,
    requestedAt: shipment.createdAt.toISOString(),
    service: shipment.service,
    // The parcel goes to whoever the Order is addressed to, who need not be the Buyer.
    receiver: {
      name: shippingAddress.name,
      company: shippingAddress.company,
      email: buyer.email,
      phone: shippingAddress.phone ?? buyer.phone,
    },
    destination: confirmed.type === 'pickup_point' ? confirmed : { type: 'address', address: shippingAddress },
    parcel: shipmentParcelSchema.safeParse(shipment.parcel).data,
    cashOnDelivery: moneyFromColumns(shipment.codAmount, shipment.codCurrency),
  })
  return request.success ? { request: request.data } : { failure: 'request_invalid' }
}
