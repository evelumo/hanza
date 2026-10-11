import type { OrderPhase } from '@hanza/connector-sdk'
import { failureOf, request, type AllegroContext } from '../client'
import { fulfillmentStatusFor } from '../mapping/status'

/**
 * Sets the seller's fulfillment status of the Order on Allegro: `PUT /order/checkout-forms/{id}/fulfillment` with
 * `{ status }` and no `checkoutForm.revision`, since Hanza owns the phase (ADR 0003) and a revision would turn every
 * Buyer edit into a 409. Repeatable: setting the same status again changes nothing.
 */
export async function updateOrderStatus(ctx: AllegroContext, input: { orderExternalId: string; phase: OrderPhase }): Promise<void> {
  const response = await request(ctx, `/order/checkout-forms/${encodeURIComponent(input.orderExternalId)}/fulfillment`, {
    method: 'PUT',
    json: { status: fulfillmentStatusFor(input.phase) },
  })
  if (!response.ok) throw await failureOf(response)
  await response.body?.cancel().catch(() => {})
}
