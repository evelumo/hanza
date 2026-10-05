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

export const ordersUpdateStatusRef = {
  name: 'orders.updateStatus',
  schema: z.object({ organizationId: id, orderId: id }),
} satisfies JobRef

const actor = z.discriminatedUnion('type', [z.object({ type: z.literal('user'), userId: id }), z.object({ type: z.literal('system') })])

/** Finishes deleting an Order status: moves its Orders to the replacement in batches, then deletes it (ADR 0014). */
export const orderStatusesDeleteRef = {
  name: 'orderStatuses.delete',
  schema: z.object({ organizationId: id, statusId: id, replacementId: id, actor }),
} satisfies JobRef

export const coalesceKeys = {
  offersPull: (connectionId: string) => `offers.pull:${connectionId}`,
  ordersPull: (connectionId: string) => `orders.pull:${connectionId}`,
  stockPush: (connectionId: string) => `stock.push:${connectionId}`,
  ordersUpdateStatus: (orderId: string) => `orders.updateStatus:${orderId}`,
  orderStatusesDelete: (statusId: string) => `orderStatuses.delete:${statusId}`,
}
