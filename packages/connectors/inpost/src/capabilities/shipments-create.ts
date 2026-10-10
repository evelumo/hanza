import { PermanentError, TransientError, type ShipmentCreateResult, type ShipmentRequest } from '@hanza/connector-sdk'
import { shipxShipmentSchema, type ShipxShipment } from '../api'
import { failure, logUntranslated, organizationShipmentsPath, parse, readError, send } from '../client'
import type { InpostContext } from '../config'
import { findEarlierShipment } from '../earlier-shipment'
import { accountRefusal, createRefusalCode, shipmentJson, toShipmentState, toShipxShipment } from '../mapping'

// Statuses that are about the call or the account, whatever the body says: never a refusal of this one request.
const CALL_FAILURES: readonly number[] = [401, 403, 404, 408, 429]

function created(ctx: InpostContext, shipment: ShipxShipment): ShipmentCreateResult {
  const state = toShipmentState(shipment)
  if (state !== null) return { outcome: 'created', ...state }
  logUntranslated(ctx, shipment)
  // The shipment exists, so nothing may be posted, and its state cannot be told without guessing: ask again later.
  throw new TransientError('InPost has this Shipment in a status the connector cannot translate')
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
    const code = error === null ? null : createRefusalCode(error)
    if (code !== null) return { outcome: 'rejected', code }
    const account = error === null ? null : accountRefusal(error.error)
    if (account !== null) throw new PermanentError(`InPost refuses new shipments for this account (${account}); the InPost manager says what it is waiting for`)
  }
  throw await failure(response, 'organization')
}
