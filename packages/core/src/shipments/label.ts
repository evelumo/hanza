import type { ShipmentLabel } from '@hanza/connector-sdk'
import type { Context } from '../context'
import { TX_OPTIONS } from '../transaction'
import { lockShipment } from './apply-state'
import { databaseNow, nextShipmentCheck } from './schedule'
import { labelFileType, MAX_LABEL_BYTES, openLabel, sealLabel, storedContentType, type LabelFileType } from './sealed'
import { isFinalStatus, type ShipmentStatus } from './statuses'

/** A Label is asked for once the Carrier confirmed the Shipment, and no more once it is final. */
export function wantsLabel(status: ShipmentStatus): boolean {
  return status !== 'requested' && status !== 'pending' && !isFinalStatus(status)
}

/**
 * Why the Label of a Shipment is no longer fetched: the file is larger than a row holds (`too_large`), what the
 * connector returned is not a Label (`invalid`), or the Carrier refuses to give one for good (`refused`). A person
 * prints it at the Carrier.
 */
export const SHIPMENT_LABEL_FAILURES = ['too_large', 'invalid', 'refused'] as const
export type ShipmentLabelFailure = (typeof SHIPMENT_LABEL_FAILURES)[number]

export function isShipmentLabelFailure(code: string | null): code is ShipmentLabelFailure {
  return (SHIPMENT_LABEL_FAILURES as readonly string[]).includes(code ?? '')
}

/**
 * Stores the Label the worker fetched, sealed and bound to the organization and the Shipment (ADR 0023). Under the
 * Order's lock, which an Erasure of that Order waits for: a Label fetched while the Buyer data was being erased is
 * dropped, never written back after it. `too_large` when the file is more than a row holds, `skipped` when nothing
 * was stored for a reason that is not the Label's (erased, final, or a Label is there already).
 */
export async function storeShipmentLabel(
  ctx: Context,
  organizationId: string,
  shipmentId: string,
  label: ShipmentLabel,
): Promise<'stored' | 'too_large' | 'skipped'> {
  if (label.data.byteLength > MAX_LABEL_BYTES) return 'too_large'
  const sealed = sealLabel(ctx.secrets, { organizationId, shipmentId }, label.data)
  const labelContentType = storedContentType(label.contentType)
  return ctx.db.$transaction(async (tx) => {
    const shipment = await lockShipment(tx, organizationId, shipmentId)
    if (!shipment || !wantsLabel(shipment.status)) return 'skipped'
    if (shipment.order.buyerDataErasedAt !== null) return 'skipped'
    const { count } = await tx.shipment.updateMany({
      where: { id: shipmentId, organizationId, label: null },
      data: { label: sealed, labelContentType, labelFailureCode: null, ...(await afterLabelWait(tx, shipment)) },
    })
    return count === 1 ? 'stored' : 'skipped'
  }, TX_OPTIONS)
}

/**
 * Stops asking for the Label of a Shipment after a failure that asking again will not mend, so the same file is not
 * downloaded at every check until the Shipment is final. Logged by Shipment id; the row keeps the code for the panel
 * ("no label could be fetched; print it at the carrier"). False when there was nothing to give up on.
 */
export async function giveUpShipmentLabel(
  ctx: Context,
  organizationId: string,
  shipmentId: string,
  code: ShipmentLabelFailure,
  /** Numbers that say more about why, for the log line: the size of a file that is too large. */
  detail: Record<string, number> = {},
): Promise<boolean> {
  const gaveUp = await ctx.db.$transaction(async (tx) => {
    const shipment = await lockShipment(tx, organizationId, shipmentId)
    if (!shipment || !wantsLabel(shipment.status) || shipment.labelContentType !== null) return false
    await tx.shipment.updateMany({
      where: { id: shipmentId, organizationId, label: null },
      data: { labelFailureCode: code, ...(await afterLabelWait(tx, shipment)) },
    })
    return true
  }, TX_OPTIONS)
  if (gaveUp) ctx.log.error('shipment label given up on', { organizationId, shipmentId, code, ...detail })
  return gaveUp
}

/**
 * The next check of a confirmed Shipment once nobody waits for its Label any more: the usual interval, not the short
 * one of the wait. A Shipment a person asked to cancel stays due as it is.
 */
async function afterLabelWait(
  tx: Parameters<typeof lockShipment>[0],
  shipment: NonNullable<Awaited<ReturnType<typeof lockShipment>>>,
): Promise<{ nextCheckAt?: Date | null }> {
  if (shipment.status !== 'ready' || shipment.cancelRequestedAt !== null) return {}
  return { nextCheckAt: nextShipmentCheck(shipment.status, shipment.createdAt, await databaseNow(tx)) }
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
