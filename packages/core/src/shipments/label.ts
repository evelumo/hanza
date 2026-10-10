import type { ShipmentLabel } from '@hanza/connector-sdk'
import type { Context } from '../context'
import { TX_OPTIONS } from '../transaction'
import { lockShipment } from './apply-state'
import { labelFileType, MAX_LABEL_BYTES, openLabel, sealLabel, storedContentType, type LabelFileType } from './sealed'
import { isFinalStatus, type ShipmentStatus } from './statuses'

/** A Label is asked for once the Carrier confirmed the Shipment, and no more once it is final. */
export function wantsLabel(status: ShipmentStatus): boolean {
  return status !== 'requested' && status !== 'pending' && !isFinalStatus(status)
}

/**
 * Stores the Label the worker fetched, sealed and bound to the organization and the Shipment (ADR 0023). Under the
 * Order's lock, which an Erasure of that Order waits for: a Label fetched while the Buyer data was being erased is
 * dropped, never written back after it. False when nothing was stored (erased, final, a Label is there already, or
 * the file is too large).
 */
export async function storeShipmentLabel(ctx: Context, organizationId: string, shipmentId: string, label: ShipmentLabel): Promise<boolean> {
  if (label.data.byteLength > MAX_LABEL_BYTES) {
    ctx.log.error('shipment label not stored: too large', { organizationId, shipmentId, bytes: label.data.byteLength })
    return false
  }
  const sealed = sealLabel(ctx.secrets, { organizationId, shipmentId }, label.data)
  const labelContentType = storedContentType(label.contentType)
  return ctx.db.$transaction(async (tx) => {
    const shipment = await lockShipment(tx, organizationId, shipmentId)
    if (!shipment || !wantsLabel(shipment.status)) return false
    const order = await tx.order.findFirst({ where: { id: shipment.orderId, organizationId }, select: { buyerDataErasedAt: true } })
    if (!order || order.buyerDataErasedAt !== null) return false
    const { count } = await tx.shipment.updateMany({ where: { id: shipmentId, organizationId, label: null }, data: { label: sealed, labelContentType } })
    return count === 1
  }, TX_OPTIONS)
}

export interface ShipmentLabelFile extends LabelFileType {
  data: Uint8Array
}

/**
 * The stored Label of one of the organization's Shipments, for a download: its bytes and a content type from an
 * allow-list (`labelFileType`). Null when the organization has no such Shipment, it has no Label (not fetched yet,
 * deleted at a final status, erased), or the stored value does not open; the Shipment id is logged then.
 */
export async function getShipmentLabel(ctx: Context, organizationId: string, shipmentId: string): Promise<ShipmentLabelFile | null> {
  const shipment = await ctx.db.shipment.findFirst({
    where: { id: shipmentId, organizationId },
    select: { label: true, labelContentType: true },
  })
  if (!shipment || shipment.label === null || shipment.labelContentType === null) return null
  try {
    return { ...labelFileType(shipment.labelContentType), data: openLabel(ctx.secrets, { organizationId, shipmentId }, shipment.label) }
  } catch {
    ctx.log.error('shipment label unreadable', { organizationId, shipmentId })
    return null
  }
}
