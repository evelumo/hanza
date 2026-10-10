import { PermanentError, type ShipmentCreateResult, type ShipmentRequest } from '@hanza/connector-sdk'
import { shipxShipmentSchema, type ShipxShipment } from '../api'
import { failure, logUntranslated, organizationShipmentsPath, parse, readError, send } from '../client'
import type { InpostContext } from '../config'
import { findEarlierShipment } from '../earlier-shipment'
import { isErrorKey, lowerBoundState, shipmentJson, toShipmentState, toShipxShipment } from '../mapping'
import { createRefusal } from '../refusals'

// Statuses that are about the call or the account, whatever the body says: never a refusal of this one request.
const CALL_FAILURES: readonly number[] = [401, 403, 404, 408, 429]

function created(ctx: InpostContext, shipment: ShipxShipment): ShipmentCreateResult {
  const state = toShipmentState(shipment)
  if (state !== null) return { outcome: 'created', ...state }
  // The shipment exists, so the answer is `created`, and a call that threw here would throw on every repeat until
  // the core failed a Shipment InPost may have bought. Its state is the least that is true; tracking refines it.
  logUntranslated(ctx, shipment)
  return { outcome: 'created', ...lowerBoundState(shipment) }
}

/**
 * Repeatable: the organization's recent shipments are searched for the `reference` before anything is posted, so a
 * call repeated after a lost answer returns the shipment the first one made instead of buying a second label.
 */
export async function createShipment(ctx: InpostContext, request: ShipmentRequest): Promise<ShipmentCreateResult> {
  const body = toShipxShipment(request, ctx.config)
  if (!body.ok) return { outcome: 'rejected', code: body.code }

  const earlier = await findEarlierShipment(ctx, request)
  if (earlier !== null) return created(ctx, earlier)

  const response = await send(ctx, organizationShipmentsPath(ctx), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: shipmentJson(body.value),
  })
  if (response.ok) return created(ctx, await parse(response, shipxShipmentSchema, 'shipment'))
  if (response.status >= 400 && response.status < 500 && !CALL_FAILURES.includes(response.status)) {
    const error = await readError(response)
    const refusal = error === null ? null : createRefusal(error)
    if (refusal?.kind === 'rejected') return { outcome: 'rejected', code: refusal.code }
    if (refusal?.kind === 'account') {
      throw new PermanentError(`InPost refuses new shipments for this account (${refusal.key}); the InPost manager says what it is waiting for`)
    }
    if (refusal?.kind === 'unknown') {
      // Not `rejected`: that is final for the Shipment, and a key nobody has seen may as well be about the account,
      // which would then fail Shipments one by one. This way the Shipment waits and the Connection shows the trouble.
      // The key goes to the log only, and only if it reads as one: an error message is stored.
      ctx.log('InPost refused a new shipment with an error key this connector does not know', { status: response.status, key: isErrorKey(error?.error) ? error.error : 'unreadable' })
      throw new PermanentError(`InPost refused a new shipment with an error this connector does not know (HTTP ${response.status}); no shipment was made, and the worker's log names the error key`)
    }
  }
  throw await failure(response, 'organization')
}
