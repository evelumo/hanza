import {
  canShip,
  findShippingService,
  moneySchema,
  shipmentParcelSchema,
  shipmentRequestProblem,
  type Money,
  type ShipmentDestination,
} from '@hanza/connector-sdk'
import type { Prisma } from '@hanza/db'
import { z } from 'zod'
import type { Actor } from '../actor'
import { afterCommit } from '../after-commit'
import type { Context } from '../context'
import { DomainError } from '../errors'
import { appendEvent } from '../events'
import { coalesceKeys, shipmentsCreateRef } from '../jobs/refs'
import { OPEN_PHASES } from '../orders/status-rules'
import { parsePrice } from '../prices/price'
import { storedBuyerDataSelect, viewBuyerData } from '../privacy/buyer-data'
import { lockOrder } from '../stock/locks'
import { TX_OPTIONS } from '../transaction'
import { databaseNow } from './schedule'
import { sealDestination, type ConfirmedDestination } from './sealed'

const MAX_POINT_ID_LENGTH = 100

/**
 * What a person confirmed for a new Shipment. `destination` is `address` for the Order's own shipping address (read
 * when the Carrier is asked, never copied here), or the pickup point they chose, which may differ from the one in the
 * Order's Delivery. `cashOnDelivery` is what the Carrier collects from the Buyer, or null.
 */
export const shipmentInputSchema = z.object({
  connectionId: z.string().min(1),
  service: z.string().min(1),
  parcel: shipmentParcelSchema,
  destination: z.discriminatedUnion('type', [
    z.object({ type: z.literal('address') }),
    // An empty point id is answered with its own error below, not as a malformed request.
    z.object({ type: z.literal('pickup_point'), pointId: z.string().trim().max(MAX_POINT_ID_LENGTH) }),
  ]),
  cashOnDelivery: moneySchema.nullable(),
})
export type ShipmentInput = z.input<typeof shipmentInputSchema>

function codAmount(cashOnDelivery: Money | null): Money | null {
  if (cashOnDelivery === null) return null
  try {
    return parsePrice(cashOnDelivery)
  } catch {
    throw new DomainError('shipment_request_invalid', 'The cash on delivery amount does not fit its currency', { problem: 'cash_on_delivery_amount' })
  }
}

/**
 * A person asks for a Shipment of an Order through one of the organization's Connections that can ship. The row is the
 * request (ADR 0023): it is inserted as `requested` and due at once, and the `shipments.create` job asks the Carrier,
 * right away if the enqueue works, otherwise when `sync.tick` finds the row (ADR 0010).
 *
 * Refused when the Order is not in phase new or processing (`shipment_order_closed`) or awaits payment
 * (`awaiting_payment`); when the Connection is not the organization's (`not_found`) or its connector makes no Shipments
 * (`not_a_carrier`); when the service is not one the connector declares (`shipment_service_unknown`), needs a pickup
 * point that was not given (`shipment_pickup_point_required`) or the request does not fit it
 * (`shipment_request_invalid`, with `details.problem`), so a connector only ever sees a request that fits a service it
 * declared; and when the Order's Buyer data is erased or does not open (`shipment_buyer_data_erased`,
 * `shipment_buyer_data_unreadable`): there is nobody to send it to.
 */
export async function requestShipment(
  ctx: Context,
  organizationId: string,
  orderId: string,
  input: ShipmentInput,
  actor: Actor,
): Promise<{ shipmentId: string }> {
  const parsed = shipmentInputSchema.safeParse(input)
  if (!parsed.success) {
    // The path only: a message could echo what the person typed.
    throw new DomainError('shipment_request_invalid', 'The shipment request is malformed', { problem: String(parsed.error.issues[0]?.path[0] ?? 'request') })
  }
  const { connectionId, service: serviceId, parcel } = parsed.data
  const cashOnDelivery = codAmount(parsed.data.cashOnDelivery)

  const shipmentId = await ctx.db.$transaction(async (tx) => {
    // The Order lock makes the phase read below the one the insert happens under: an Order shipped or cancelled at
    // the same moment is either seen as such, or closes after this Shipment exists.
    if (!(await lockOrder(tx, organizationId, orderId))) throw new DomainError('not_found')
    const order = await tx.order.findFirst({
      where: { id: orderId, organizationId },
      select: { phase: true, awaitingPayment: true, ...storedBuyerDataSelect },
    })
    if (!order) throw new DomainError('not_found')
    if (!OPEN_PHASES.includes(order.phase)) throw new DomainError('shipment_order_closed')
    if (order.awaitingPayment) throw new DomainError('awaiting_payment')

    const connection = await tx.connection.findFirst({ where: { id: connectionId, organizationId }, select: { connectorId: true } })
    if (!connection) throw new DomainError('not_found')
    const connector = ctx.connectors.get(connection.connectorId)
    if (!connector) throw new DomainError('unknown_connector')
    if (!canShip(connector)) throw new DomainError('not_a_carrier')
    const service = findShippingService(connector, serviceId)
    if (!service) throw new DomainError('shipment_service_unknown')

    const confirmed: ConfirmedDestination = parsed.data.destination
    if (service.destination === 'pickup_point' && (confirmed.type !== 'pickup_point' || confirmed.pointId === '')) {
      throw new DomainError('shipment_pickup_point_required')
    }

    const buyerData = viewBuyerData(ctx.secrets, order)
    if (buyerData.state === 'erased') throw new DomainError('shipment_buyer_data_erased')
    if (buyerData.state === 'unreadable') throw new DomainError('shipment_buyer_data_unreadable')

    const destination: ShipmentDestination =
      confirmed.type === 'pickup_point' ? confirmed : { type: 'address', address: buyerData.data.shippingAddress }
    const problem = shipmentRequestProblem(service, { destination, parcel, cashOnDelivery })
    if (problem !== null) throw new DomainError('shipment_request_invalid', `The request does not fit the service: ${problem}`, { problem })

    const now = await databaseNow(tx)
    const created = await tx.shipment.create({
      data: {
        organizationId,
        orderId,
        connectionId,
        service: service.id,
        parcel: parcel as Prisma.InputJsonObject,
        codAmount: cashOnDelivery?.amount ?? null,
        codCurrency: cashOnDelivery?.currency ?? null,
        nextCheckAt: now,
        createdByUserId: actor.type === 'user' ? actor.userId : null,
        createdAt: now,
      },
      select: { id: true },
    })
    // Sealed in a second statement: the value is bound to the Shipment's id, which the insert makes.
    await tx.shipment.updateMany({
      where: { id: created.id, organizationId },
      data: { destination: sealDestination(ctx.secrets, { organizationId, shipmentId: created.id }, confirmed) },
    })
    await appendEvent(tx, {
      organizationId,
      type: 'shipment.requested',
      subject: { type: 'order', id: orderId },
      // Which service through which Connection, never where to (ADR 0016).
      payload: { shipmentId: created.id, connectionId, service: service.id, actor },
    })
    return created.id
  }, TX_OPTIONS)

  // A failed enqueue is recovered by the sweep in `sync.tick`: the row stays `requested` and due.
  await afterCommit(ctx, { job: shipmentsCreateRef.name, organizationId, shipmentId }, () =>
    ctx.queue.enqueue(shipmentsCreateRef, { organizationId, shipmentId }, { coalesceKey: coalesceKeys.shipmentsCreate(shipmentId) }),
  )
  return { shipmentId }
}
