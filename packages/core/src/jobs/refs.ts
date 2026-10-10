import { z } from 'zod'
import type { JobRef } from '../jobs'

// Refs only: the handlers (slice C) reuse them with `defineJob({ ...ref, handler })`,
// so services can enqueue these jobs without depending on the sync engine.

const id = z.string().min(1)
const trigger = z.enum(['schedule', 'manual'])

export const syncTickRef = {
  name: 'sync.tick',
  schema: z.object({}),
} satisfies JobRef

export const offersPullRef = {
  name: 'offers.pull',
  schema: z.object({ organizationId: id, connectionId: id, trigger }),
} satisfies JobRef

export const ordersPullRef = {
  name: 'orders.pull',
  schema: z.object({ organizationId: id, connectionId: id, trigger }),
} satisfies JobRef

export const stockPushRef = {
  name: 'stock.push',
  schema: z.object({ organizationId: id, connectionId: id }),
} satisfies JobRef

export const pricePushRef = {
  name: 'price.push',
  schema: z.object({ organizationId: id, connectionId: id }),
} satisfies JobRef

export const ordersUpdateStatusRef = {
  name: 'orders.updateStatus',
  schema: z.object({ organizationId: id, orderId: id }),
} satisfies JobRef

const actor = z.discriminatedUnion('type', [z.object({ type: z.literal('user'), userId: id }), z.object({ type: z.literal('system') })])

/** Finishes deleting an Order status: moves its Orders to the replacement recorded on it, then deletes it (ADR 0018). */
export const orderStatusesDeleteRef = {
  name: 'orderStatuses.delete',
  schema: z.object({ organizationId: id, statusId: id, actor }),
} satisfies JobRef

export const privacyTickRef = {
  name: 'privacy.tick',
  schema: z.object({}),
} satisfies JobRef

export const privacySweepRef = {
  name: 'privacy.sweep',
  schema: z.object({ organizationId: id }),
} satisfies JobRef

export const signInStartRef = {
  name: 'connections.signIn.start',
  schema: z.object({ organizationId: id, signInId: id }),
} satisfies JobRef

export const signInPollRef = {
  name: 'connections.signIn.poll',
  schema: z.object({ organizationId: id, signInId: id }),
} satisfies JobRef

/** Asks the Carrier for one Shipment still `requested` (ADR 0023). */
export const shipmentsCreateRef = {
  name: 'shipments.create',
  schema: z.object({ organizationId: id, shipmentId: id }),
} satisfies JobRef

/** Follows the due Shipments of one Connection at their Carrier: cancels, statuses, Labels. */
export const shipmentsTrackRef = {
  name: 'shipments.track',
  schema: z.object({ organizationId: id, connectionId: id }),
} satisfies JobRef

export const coalesceKeys = {
  offersPull: (connectionId: string) => `offers.pull:${connectionId}`,
  ordersPull: (connectionId: string) => `orders.pull:${connectionId}`,
  stockPush: (connectionId: string) => `stock.push:${connectionId}`,
  pricePush: (connectionId: string) => `price.push:${connectionId}`,
  ordersUpdateStatus: (orderId: string) => `orders.updateStatus:${orderId}`,
  orderStatusesDelete: (statusId: string) => `orderStatuses.delete:${statusId}`,
  privacySweep: (organizationId: string) => `privacy.sweep:${organizationId}`,
  signInStart: (signInId: string) => `connections.signIn.start:${signInId}`,
  signInPoll: (signInId: string) => `connections.signIn.poll:${signInId}`,
  shipmentsCreate: (shipmentId: string) => `shipments.create:${shipmentId}`,
  shipmentsTrack: (connectionId: string) => `shipments.track:${connectionId}`,
  /**
   * The delayed `shipments.track` that makes a new Shipment's first check. A key of its own, per Shipment: under the
   * Connection's key a job that waits for its delay drops every request that comes meanwhile, and is itself dropped
   * while another one waits, which would leave the check of this Shipment (or of the next one made) to the tick.
   */
  shipmentsFirstCheck: (shipmentId: string) => `shipments.track:first:${shipmentId}`,
}
