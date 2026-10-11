import { z } from 'zod'
import { allegroDateTime, allegroEnum } from './common'

/** `OrderEventType`. Parsed as any string (see `allegroEnum`): the feed reads every event's checkout form whatever its type. */
export const ORDER_EVENT_TYPES = [
  'BOUGHT',
  'FILLED_IN',
  'READY_FOR_PROCESSING',
  'BUYER_CANCELLED',
  'FULFILLMENT_STATUS_CHANGED',
  'BUYER_MODIFIED',
  'AUTO_CANCELLED',
] as const
export type OrderEventType = (typeof ORDER_EVENT_TYPES)[number]

/**
 * One event of `GET /order/events` (`OrderEvent`). Only the checkout form reference is modelled: the event's buyer and
 * line items are a snapshot the feed does not use (it reads the checkout form itself). `checkoutForm` is optional in
 * the OpenAPI, so an event without one parses and the feed has to skip it.
 */
export const orderEventSchema = z.object({
  id: z.string().min(1),
  type: allegroEnum,
  occurredAt: allegroDateTime,
  order: z.object({
    checkoutForm: z
      .object({
        id: z.string().min(1),
        revision: z.string().nullish(),
      })
      .nullish(),
  }),
})
export type OrderEvent = z.infer<typeof orderEventSchema>

/** `GET /order/events` (`OrderEventsList`), oldest first. */
export const orderEventsPageSchema = z.object({
  events: z.array(orderEventSchema),
})
export type OrderEventsPage = z.infer<typeof orderEventsPageSchema>

/** `GET /order/event-stats` (`OrderEventStats`). `latestEvent` is absent for a seller whose journal is empty. */
export const orderEventStatsSchema = z.object({
  latestEvent: z
    .object({
      id: z.string().min(1),
      occurredAt: allegroDateTime,
    })
    .nullish(),
})
export type OrderEventStats = z.infer<typeof orderEventStatsSchema>
