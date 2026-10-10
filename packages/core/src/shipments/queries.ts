import { canShip, findShippingService, shipmentParcelSchema, type Money, type ShipmentParcel, type ShippingService } from '@hanza/connector-sdk'
import type { ConnectionHealth, Prisma } from '@hanza/db'
import type { Context } from '../context'
import { moneyFromColumns } from '../prices/price'
import { isFinalStatus, isHandedOver, type ShipmentStatus } from './statuses'

/** A Shipment as the panel shows it. Nothing sealed is in it: not the destination, and of the Label only whether one is stored. */
export interface ShipmentRow {
  id: string
  orderId: string
  connectionId: string
  connectionName: string
  status: ShipmentStatus
  /** The connector's service id, and its name while the connector still declares it. */
  service: string
  serviceName: string | null
  /** Null when the stored parcel no longer parses. */
  parcel: ShipmentParcel | null
  cashOnDelivery: Money | null
  /** The Carrier's id of the Shipment; null until its answer to the request is stored. */
  externalId: string | null
  trackingNumber: string | null
  /** The Carrier's own status key, a short code. */
  carrierStatus: string | null
  /** Why it failed (a Carrier's code, `carrier_timeout`, `buyer_data_erased`, …); null unless `status` is `failed`. */
  failureCode: string | null
  /** The code the Carrier gave when it refused to cancel a Shipment that goes on: "too late, cancel it at the carrier". */
  cancelRefusedCode: string | null
  /** Set while a cancel a person asked for has not been put to the Carrier. */
  cancelRequestedAt: Date | null
  /** Whether a person may ask to cancel it now (`cancelShipment` decides for good). */
  canCancel: boolean
  /** Whether `getShipmentLabel` has a file to serve. */
  hasLabel: boolean
  /** When the Carrier was first seen to have the parcel. */
  handedOverAt: Date | null
  createdAt: Date
  updatedAt: Date
}

// `destination` and `label` are deliberately absent: panel queries never select the sealed columns.
const rowSelect = {
  id: true,
  orderId: true,
  connectionId: true,
  status: true,
  service: true,
  parcel: true,
  codAmount: true,
  codCurrency: true,
  externalId: true,
  trackingNumber: true,
  carrierStatus: true,
  failureCode: true,
  labelContentType: true,
  cancelRequestedAt: true,
  handedOverAt: true,
  createdAt: true,
  updatedAt: true,
  connection: { select: { name: true, connectorId: true } },
} as const satisfies Prisma.ShipmentSelect

/** The Shipments of one of the organization's Orders, oldest first. */
export async function listOrderShipments(ctx: Context, organizationId: string, orderId: string): Promise<ShipmentRow[]> {
  const rows = await ctx.db.shipment.findMany({
    where: { organizationId, orderId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: rowSelect,
  })
  return rows.map((row) => {
    const connector = ctx.connectors.get(row.connection.connectorId)
    const parcel = shipmentParcelSchema.safeParse(row.parcel)
    const open = !isFinalStatus(row.status) && !isHandedOver(row.status)
    const failed = row.status === 'failed'
    return {
      id: row.id,
      orderId: row.orderId,
      connectionId: row.connectionId,
      connectionName: row.connection.name,
      status: row.status,
      service: row.service,
      serviceName: (connector && findShippingService(connector, row.service)?.name) ?? null,
      parcel: parcel.success ? parcel.data : null,
      cashOnDelivery: moneyFromColumns(row.codAmount, row.codCurrency),
      externalId: row.externalId,
      trackingNumber: row.trackingNumber,
      carrierStatus: row.carrierStatus,
      failureCode: failed ? row.failureCode : null,
      cancelRefusedCode: failed ? null : row.failureCode,
      cancelRequestedAt: row.cancelRequestedAt,
      canCancel: open && row.cancelRequestedAt === null && (row.externalId === null || connector?.capabilities['shipments.cancel'] !== undefined),
      // Set and cleared together with the sealed file (a CHECK on the table).
      hasLabel: row.labelContentType !== null,
      handedOverAt: row.handedOverAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  })
}

/** A Connection Shipments can be made through, with what the form for a new Shipment is built from. */
export interface ShippingConnection {
  id: string
  name: string
  connectorId: string
  /** The connector's name: the Carrier, or a Channel with shipping of its own. */
  connectorName: string
  health: ConnectionHealth
  services: ShippingService[]
  /** Whether a Shipment the Carrier has confirmed can still be cancelled through Hanza. */
  canCancel: boolean
}

/** The organization's Connections whose connector makes Shipments, oldest first. */
export async function listShippingConnections(ctx: Context, organizationId: string): Promise<ShippingConnection[]> {
  const connections = await ctx.db.connection.findMany({
    where: { organizationId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true, connectorId: true, health: true },
  })
  return connections.flatMap((connection) => {
    const connector = ctx.connectors.get(connection.connectorId)
    if (!connector || !canShip(connector)) return []
    return [
      {
        ...connection,
        connectorName: connector.name,
        services: connector.shipping?.services ?? [],
        canCancel: connector.capabilities['shipments.cancel'] !== undefined,
      },
    ]
  })
}
