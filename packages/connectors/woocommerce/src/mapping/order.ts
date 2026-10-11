import {
  addressSchema,
  orderSchema,
  orderUpdateSchema,
  PermanentError,
  type Address,
  type ChannelFact,
  type Order,
  type OrderUpdate,
} from '@hanza/connector-sdk'
import type { WooAddress, WooLineItem, WooOrder } from '../api'
import { addDecimal, divideDecimal, toMoneyAmount } from '../decimal'
import { lineOfferId } from './offer'
import { CANCELLED_STATUSES, PAID_STATUSES } from './status'

const COD = 'cod'

/** A `_gmt` date of the API (`2026-09-21T07:20:00`, UTC without saying so) as an ISO instant. */
export function toInstant(gmt: string): string {
  return `${gmt}Z`
}

function isCashOnDelivery(order: WooOrder): boolean {
  return order.payment_method === COD
}

/**
 * Every Channel fact the snapshot shows, oldest first. Ids are `<order id>:<type>`, so the same fact has the same
 * id on every pull, whatever its time is by then.
 */
export function orderFacts(order: WooOrder): ChannelFact[] {
  const modified = toInstant(order.date_modified_gmt)
  const facts: ChannelFact[] = []
  // Cash on delivery is never "paid" for Hanza: WooCommerce stamps `date_paid` on it only when it is completed.
  if (!isCashOnDelivery(order) && (order.date_paid_gmt !== null || PAID_STATUSES.includes(order.status))) {
    facts.push({ id: `${order.id}:paid`, type: 'paid', occurredAt: order.date_paid_gmt === null ? modified : toInstant(order.date_paid_gmt), note: null })
  }
  // `date_completed` outlives the status: an order moved on from `completed` (refunded, reopened) was still shipped.
  if (order.status === 'completed' || order.date_completed_gmt !== null) {
    facts.push({
      id: `${order.id}:shipped`,
      type: 'shipped',
      occurredAt: order.date_completed_gmt === null ? modified : toInstant(order.date_completed_gmt),
      note: null,
    })
  }
  // The note names one of WooCommerce's own four statuses, found in the fixed list: never a text the shop made up
  // (a plugin's status is no cancellation), since the note ends up in an Event.
  const cancelledAs = CANCELLED_STATUSES.find((status) => status === order.status)
  if (cancelledAs !== undefined) {
    facts.push({ id: `${order.id}:cancelled`, type: 'cancelled', occurredAt: modified, note: `WooCommerce status: ${cancelledAs}` })
  }
  // ISO instants of one format compare as text; the sort is stable, so facts of one moment stay paid, shipped, cancelled.
  return facts.sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0))
}

/** Open: neither shipped nor cancelled, as far as the snapshot's facts say. A closed order is never imported in full. */
export function isOpen(order: WooOrder): boolean {
  return !orderFacts(order).some((fact) => fact.type === 'shipped' || fact.type === 'cancelled')
}

/** A prepaid order nobody paid for yet (`pending`, `on-hold`, a plugin's status, or closed without ever being paid). */
export function isAwaitingPayment(order: WooOrder): boolean {
  return !isCashOnDelivery(order) && !orderFacts(order).some((fact) => fact.type === 'paid')
}

const orNull = (value: string) => (value.trim() === '' ? null : value.trim())

function personName(address: WooAddress): string {
  return `${address.first_name} ${address.last_name}`.trim()
}

/** Nothing that says where or to whom: WooCommerce's shipping address of virtual goods and of "ship to billing". */
export function isEmptyAddress(address: WooAddress): boolean {
  const { first_name, last_name, company, address_1, address_2, city, postcode, country } = address
  return [first_name, last_name, company, address_1, address_2, city, postcode, country].every((value) => value.trim() === '')
}

/** The address as the canonical one, or null when it lacks something the canonical address requires. */
export function mapAddress(address: WooAddress): Address | null {
  const mapped = addressSchema.safeParse({
    name: personName(address) || address.company.trim(),
    company: orNull(address.company),
    street: [address.address_1, address.address_2].map((part) => part.trim()).filter((part) => part !== '').join(', '),
    postalCode: address.postcode.trim(),
    city: address.city.trim(),
    countryCode: address.country.trim().toUpperCase(),
    phone: orNull(address.phone),
    // WooCommerce has no tax id field; plugins keep it in order meta (a follow-up).
    taxId: null,
  })
  return mapped.success ? mapped.data : null
}

/** `(total + total_tax) / quantity`: what the Buyer pays for one unit, tax included, after discounts. Never the float `price`. */
export function unitPriceAmount(line: Pick<WooLineItem, 'total' | 'total_tax' | 'quantity'>): string | null {
  const gross = addDecimal(line.total, line.total_tax)
  return gross === null ? null : divideDecimal(gross, line.quantity)
}

/** `problems` are field paths of the canonical Order (`lines`, `shippingAddress`, `lines.0.quantity`), never values. */
export type MappedOrder = { fits: true; order: Order } | { fits: false; externalId: string; problems: string[] }

// What an order's own data decides. A problem anywhere else (the id, a date, a fact, the payment flags) can only
// come from this mapper, and is a bug that must not pass as "this order does not fit".
const DATA_PATHS = ['total', 'buyer', 'shippingAddress', 'billingAddress', 'lines']

// Hanza keeps a line's quantity in a 32-bit column and refuses the whole page for one Order above it, which would
// stop the feed. `orderSchema` does not know that limit.
const MAX_QUANTITY = 2_147_483_647

/**
 * A snapshot as a full canonical Order, validated; or, for an order the canonical model cannot hold (no lines, a
 * fractional quantity, no usable address, an amount that is not money), the paths that do not fit, so the feed can
 * skip it instead of failing its page. Throws a `PermanentError` only for a mapper bug.
 */
export function mapOrder(order: WooOrder): MappedOrder {
  const externalId = String(order.id)
  const billing = mapAddress(order.billing)
  // A shipping address that is filled in but incomplete is not replaced by the billing one: the parcel was meant
  // to go somewhere else.
  const shipping = isEmptyAddress(order.shipping) ? billing : mapAddress(order.shipping)
  const facts = orderFacts(order)
  const candidate = {
    externalId,
    placedAt: toInstant(order.date_created_gmt),
    payment: isCashOnDelivery(order) ? 'cash_on_delivery' : 'prepaid',
    ...(isAwaitingPayment(order) ? { awaitingPayment: true } : {}),
    total: { amount: toMoneyAmount(order.total) ?? '', currency: order.currency },
    buyer: {
      name: personName(order.billing) || order.billing.company.trim() || personName(order.shipping) || order.shipping.company.trim(),
      email: orNull(order.billing.email),
      phone: orNull(order.billing.phone),
      login: null,
    },
    shippingAddress: shipping ?? undefined,
    billingAddress: billing,
    lines: order.line_items.map((line) => ({
      externalId: String(line.id),
      offerExternalId: lineOfferId(line.product_id, line.variation_id),
      sku: orNull(line.sku),
      name: line.name.trim(),
      quantity: line.quantity,
      unitPrice: { amount: unitPriceAmount(line) ?? '', currency: order.currency },
    })),
    facts,
  }
  const mapped = orderSchema.safeParse(candidate)
  if (mapped.success) {
    const tooMany = mapped.data.lines.flatMap((line, index) => (line.quantity > MAX_QUANTITY ? [`lines.${index}.quantity`] : []))
    return tooMany.length === 0 ? { fits: true, order: mapped.data } : { fits: false, externalId, problems: tooMany }
  }

  const problems = [...new Set(mapped.error.issues.map((issue) => issue.path.join('.')))]
  const bugs = problems.filter((path) => !DATA_PATHS.includes(path.split('.')[0] ?? ''))
  if (bugs.length > 0) throw new PermanentError(`Order ${externalId} was mapped to an invalid canonical Order: ${bugs.join(', ')}`)
  return { fits: false, externalId, problems }
}

/** The snapshot's facts alone, as an Order update: for an order from before the feed's boundary that is closed, or one that does not fit. */
export function mapOrderUpdate(order: WooOrder): OrderUpdate {
  const mapped = orderUpdateSchema.safeParse({ kind: 'update', externalId: String(order.id), facts: orderFacts(order) })
  if (!mapped.success) {
    throw new PermanentError(`Order ${order.id} was mapped to an invalid Order update: ${mapped.error.issues.map((issue) => issue.path.join('.')).join(', ')}`)
  }
  return mapped.data
}
