import type { ShipmentCancelResult } from '@hanza/connector-sdk'
import { failure, readError, send, shipmentPath, shipmentsById } from '../client'
import type { InpostContext } from '../config'
import { CANCELLED_STATUS } from '../statuses'

/**
 * ShipX cancels only before the purchase (`created`, `offers_prepared`), which in simplified mode is a matter of
 * seconds; afterwards it answers `invalid_action`.
 */
export async function cancelShipment(ctx: InpostContext, input: { externalId: string }): Promise<ShipmentCancelResult> {
  const response = await send(ctx, shipmentPath(input.externalId), { method: 'DELETE' })
  // A 404 is read as cancelled: the id came from this Connection's own create, so a shipment ShipX no longer has is
  // one an earlier cancel removed (its answer was lost), and the contract counts a Shipment that is gone as cancelled.
  if (response.ok || response.status === 404) {
    await response.body?.cancel().catch(() => {})
    return { outcome: 'cancelled' }
  }
  if (response.status >= 400 && response.status < 500 && response.status !== 401 && response.status !== 429) {
    const error = await readError(response)
    if (error?.error === 'invalid_action') {
      // Also what a repeated cancel gets if ShipX keeps a cancelled shipment instead of removing it: its status tells.
      const shipment = (await shipmentsById(ctx, [input.externalId])).get(input.externalId)
      return shipment?.status === CANCELLED_STATUS ? { outcome: 'cancelled' } : { outcome: 'refused', code: 'too_late' }
    }
  }
  throw await failure(response, 'shipment')
}
