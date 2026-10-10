import type { ShipmentStatus } from '@hanza/connector-sdk'

/**
 * Every status name `GET /v1/statuses` lists (53 on production and on the sandbox, 2026-10-10), translated to a
 * Shipment status. `null` is a name known on purpose not to say where the parcel is: the Shipment keeps its status.
 * A name missing from this table is new at InPost: the Shipment is left out of the answer and the name is logged.
 */
export const INPOST_STATUSES: Readonly<Record<string, ShipmentStatus | null>> = {
  // Before the purchase: InPost has the request and has not bought the label.
  created: 'pending',
  offers_prepared: 'pending',
  offer_selected: 'pending',

  confirmed: 'ready',

  dispatched_by_sender: 'in_transit',
  dispatched_by_sender_to_pok: 'in_transit',
  collected_from_sender: 'in_transit',
  taken_by_courier: 'in_transit',
  taken_by_courier_from_pok: 'in_transit',
  adopted_at_source_branch: 'in_transit',
  sent_from_source_branch: 'in_transit',
  adopted_at_sorting_center: 'in_transit',
  sent_from_sorting_center: 'in_transit',
  adopted_at_target_branch: 'in_transit',
  out_for_delivery: 'in_transit',
  out_for_delivery_to_address: 'in_transit',
  readdressed: 'in_transit',
  redirect_to_box: 'in_transit',
  // The rerouting to a locker was called off, not the parcel: it goes on to the address.
  canceled_redirect_to_box: 'in_transit',
  delay_in_delivery: 'in_transit',
  stack_in_customer_service_point: 'in_transit',
  stack_in_box_machine: 'in_transit',
  unstack_from_customer_service_point: 'in_transit',
  unstack_from_box_machine: 'in_transit',

  ready_to_pickup: 'awaiting_pickup',
  ready_to_pickup_from_pok: 'awaiting_pickup',
  ready_to_pickup_from_pok_registered: 'awaiting_pickup',
  ready_to_pickup_from_branch: 'awaiting_pickup',
  pickup_reminder_sent: 'awaiting_pickup',
  avizo: 'awaiting_pickup',
  courier_avizo_in_customer_service_point: 'awaiting_pickup',

  // Named like a pickup reminder, but its text is "courier did not find the Recipient at the indicated address".
  pickup_reminder_sent_address: 'delivery_problem',
  undelivered: 'delivery_problem',
  undelivered_wrong_address: 'delivery_problem',
  undelivered_incomplete_address: 'delivery_problem',
  undelivered_unknown_receiver: 'delivery_problem',
  undelivered_cod_cash_receiver: 'delivery_problem',
  undelivered_no_mailbox: 'delivery_problem',
  undelivered_not_live_address: 'delivery_problem',
  undelivered_lack_of_access_letterbox: 'delivery_problem',
  rejected_by_receiver: 'delivery_problem',
  pickup_time_expired: 'delivery_problem',
  stack_parcel_pickup_time_expired: 'delivery_problem',
  stack_parcel_in_box_machine_pickup_time_expired: 'delivery_problem',
  claimed: 'delivery_problem',
  // "Does not fit into the locker." Who holds the parcel then is not documented.
  oversized: 'delivery_problem',
  // "Will soon be on its way back to the Sender": not back yet, and `returned` is final.
  taken_by_courier_from_customer_service_point: 'delivery_problem',

  delivered: 'delivered',
  return_pickup_confirmation_to_sender: 'delivered',

  returned_to_sender: 'returned',

  canceled: 'cancelled',

  // "The parcel is in an unrecognized status": InPost itself does not know.
  other: null,
  // No title, no description ("translation missing") and no origin status in the live list: nothing says InPost
  // ever held the parcel, and a status that says so ships the Order.
  missing: null,
}

/** The statuses in which InPost is still preparing and buying the offer, so a purchase can still fail. */
export const PURCHASE_STATUSES: readonly string[] = ['created', 'offers_prepared', 'offer_selected']

/** The ShipX status after a cancellation. */
export const CANCELLED_STATUS = 'canceled'
