import { TransientError, type ShipmentCancelResult } from '@hanza/connector-sdk'
import { isShipmentId } from '../api'
import { failure, readError, send, shipmentPath, shipmentsById } from '../client'
import type { InpostContext } from '../config'
import { CANCELLED_STATUS } from '../statuses'

const NOT_FOUND: ShipmentCancelResult = { outcome: 'refused', code: 'not_found' }

/** What the shipment's own status says about a cancel, read where a new status shows at once. */
async function byStatus(ctx: InpostContext, externalId: string): Promise<'cancelled' | 'alive' | 'unknown'> {
  const shipment = (await shipmentsById(ctx, [externalId])).get(externalId)
  if (shipment === undefined) return 'unknown'
  return shipment.status === CANCELLED_STATUS ? 'cancelled' : 'alive'
}

/**
 * ShipX cancels only before the purchase (`created`, `offers_prepared`), which in simplified mode is the first
 * tenth of a second or so; afterwards it answers `invalid_action`. A cancelled shipment is kept, as `canceled`,
 * and a second `DELETE` of it gets `invalid_action` too (sandbox, 2026-10-10), so its status tells the two apart.
 */
export async function cancelShipment(ctx: InpostContext, input: { externalId: string }): Promise<ShipmentCancelResult> {
  // Not an id InPost gives: nothing it could know, and nothing that may go into a path.
  if (!isShipmentId(input.externalId)) return NOT_FOUND
  const response = await send(ctx, shipmentPath(input.externalId), { method: 'DELETE' })
  if (response.status === 204) return { outcome: 'cancelled' }
  if (response.status === 404) {
    // "No access to the resource or the shipment does not exist": never proof of a cancel. A token of another
    // organization gets the same 404 for a label that is bought, and so does an error page of the edge.
    await response.body?.cancel().catch(() => {})
    return NOT_FOUND
  }
  if (response.ok) {
    // Not the documented answer, so the shipment's status decides, and a shipment still alive is asked about again.
    await response.body?.cancel().catch(() => {})
    const status = await byStatus(ctx, input.externalId)
    if (status === 'cancelled') return { outcome: 'cancelled' }
    throw new TransientError(`InPost answered the cancel with ${response.status} and did not cancel the shipment`)
  }
  if (response.status >= 400 && response.status < 500 && response.status !== 401 && response.status !== 403 && response.status !== 408 && response.status !== 429) {
    const error = await readError(response)
    if (error?.error === 'invalid_action') {
      const status = await byStatus(ctx, input.externalId)
      if (status === 'cancelled') return { outcome: 'cancelled' }
      return status === 'alive' ? { outcome: 'refused', code: 'too_late' } : NOT_FOUND
    }
  }
  throw await failure(response, 'shipment')
}
