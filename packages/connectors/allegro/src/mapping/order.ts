import { orderSchema, orderUpdateSchema, PermanentError } from '@hanza/connector-sdk'
import type { Address, ChannelFact, Order, OrderLine, OrderUpdate, PaymentMethod } from '@hanza/connector-sdk'
import { issuePaths } from '../api/common'
import type { CheckoutForm, CheckoutFormAddress } from '../api/orders'

// Statuses of a checkout form whose Buyer has not paid yet (a prepaid one is awaiting payment).
const UNPAID_STATUSES: readonly string[] = ['BOUGHT', 'FILLED_IN']
const SHIPPED_FULFILLMENT_STATUSES: readonly string[] = ['SENT', 'PICKED_UP']
// The tax id that goes on an invoice, by preference; otherwise the first one given.
const TAX_ID_PREFERENCE = ['PL_NIP', 'VAT_EU'] as const

function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function fullName(firstName: string | null | undefined, lastName: string | null | undefined): string | null {
  return text([text(firstName), text(lastName)].filter((part) => part !== null).join(' '))
}

function buyerNameOf(form: CheckoutForm): string | null {
  const { buyer } = form
  return fullName(buyer.firstName, buyer.lastName) ?? text(buyer.companyName) ?? text(buyer.login)
}

function paymentOf(form: CheckoutForm): PaymentMethod {
  return form.payment?.type === 'CASH_ON_DELIVERY' ? 'cash_on_delivery' : 'prepaid'
}

function earliest(times: readonly string[]): string | null {
  let result: string | null = null
  for (const time of times) if (result === null || Date.parse(time) < Date.parse(result)) result = time
  return result
}

function latest(times: readonly string[]): string | null {
  let result: string | null = null
  for (const time of times) if (result === null || Date.parse(time) > Date.parse(result)) result = time
  return result
}

function boughtAtTimes(form: CheckoutForm): string[] {
  return form.lineItems.flatMap((item) => (item.boughtAt ? [item.boughtAt] : []))
}

/** When the Order was placed: the earliest `lineItems[].boughtAt` (`updatedAt` if no line says, which Allegro always does). */
export function placedAtOf(form: CheckoutForm): string {
  const placedAt = earliest(boughtAtTimes(form)) ?? form.updatedAt
  if (!placedAt) throw new PermanentError(`Allegro checkout form ${form.id} has no purchase time (lineItems.boughtAt)`)
  return placedAt
}

/**
 * The purchase time the Order feed compares with its boundary and pages the listing by: the latest
 * `lineItems[].boughtAt`, which is what the `lineItems.boughtAt` filters of `GET /order/checkout-forms` compare
 * ("Latest line item bought date"). One key for both phases, so a form whose lines were bought on both sides of the
 * boundary is either listed or sent in full, never neither. The Order's `placedAt` stays the earliest.
 */
export function boundaryKeyOf(form: CheckoutForm): string {
  return latest(boughtAtTimes(form)) ?? placedAtOf(form)
}

// When the form last changed, for the facts that have no time of their own. `updatedAt` is optional in the OpenAPI.
function changedAtOf(form: CheckoutForm): string {
  const finishedAt = form.payment?.finishedAt
  return form.updatedAt ?? latest([...boughtAtTimes(form), ...(finishedAt ? [finishedAt] : [])]) ?? placedAtOf(form)
}

/** Orders Allegro fulfils from its own warehouse (One Fulfillment): Hanza does not manage them. */
export function isOneFulfillment(form: CheckoutForm): boolean {
  return form.fulfillment?.provider?.id === 'ALLEGRO'
}

function completeDeliveryAddress(form: CheckoutForm): CheckoutFormAddress | null {
  const address = form.delivery?.address
  if (!address) return null
  const complete = [address.street, address.city, address.zipCode, address.countryCode].every((value) => text(value) !== null)
  return complete ? address : null
}

function completeBuyerAddress(form: CheckoutForm) {
  const address = form.buyer.address
  if (!address) return null
  const complete = [address.street, address.city, address.postCode, address.countryCode].every((value) => text(value) !== null)
  return complete ? address : null
}

/**
 * Whether the form has an address to ship to: the delivery address, or the Buyer's account address (all a form
 * awaiting payment may have). A form without either is not worth sending yet: a later event brings it again.
 */
export function hasUsableAddress(form: CheckoutForm): boolean {
  return completeDeliveryAddress(form) !== null || completeBuyerAddress(form) !== null
}

function shippingAddressOf(form: CheckoutForm): Address | null {
  const delivery = completeDeliveryAddress(form)
  if (delivery) {
    return {
      name: fullName(delivery.firstName, delivery.lastName) ?? text(delivery.companyName) ?? buyerNameOf(form) ?? '',
      company: text(delivery.companyName),
      street: text(delivery.street) ?? '',
      postalCode: text(delivery.zipCode) ?? '',
      city: text(delivery.city) ?? '',
      countryCode: (text(delivery.countryCode) ?? '').toUpperCase(),
      phone: text(delivery.phoneNumber),
      taxId: null,
    }
  }
  // Until the Buyer fills in the checkout form, the account address is the best one Allegro gives (never shipped to:
  // such an Order is awaiting payment).
  const account = completeBuyerAddress(form)
  if (account) {
    return {
      name: buyerNameOf(form) ?? '',
      company: text(form.buyer.companyName),
      street: text(account.street) ?? '',
      postalCode: text(account.postCode) ?? '',
      city: text(account.city) ?? '',
      countryCode: (text(account.countryCode) ?? '').toUpperCase(),
      phone: text(form.buyer.phoneNumber),
      taxId: null,
    }
  }
  return null
}

function billingAddressOf(form: CheckoutForm): Address | null {
  const invoice = form.invoice
  if (!invoice?.required || !invoice.address) return null
  const { address } = invoice
  const company = address.company
  const ids = company?.ids ?? []
  const taxId =
    TAX_ID_PREFERENCE.map((type) => ids.find((id) => id.type === type)).find((id) => id !== undefined) ?? ids[0]
  return {
    name:
      text(company?.name) ??
      fullName(address.naturalPerson?.firstName, address.naturalPerson?.lastName) ??
      buyerNameOf(form) ??
      '',
    company: text(company?.name),
    street: text(address.street) ?? '',
    postalCode: text(address.zipCode) ?? '',
    city: text(address.city) ?? '',
    countryCode: (text(address.countryCode) ?? '').toUpperCase(),
    phone: null,
    taxId: text(taxId?.value),
  }
}

/**
 * The Channel facts the form implies now, oldest first, with ids stable per Order: `paid` when a prepaid payment
 * finished or the form is `READY_FOR_PROCESSING` (cash on delivery never gets one), `shipped` for fulfillment `SENT` / `PICKED_UP`, `cancelled` when the
 * form or its fulfillment is `CANCELLED`. Notes are always null (they could quote the Buyer).
 */
export function factsOf(form: CheckoutForm): ChannelFact[] {
  const facts: ChannelFact[] = []
  const finishedAt = form.payment?.finishedAt
  // READY_FOR_PROCESSING means paid for a prepaid form, even when Allegro leaves `finishedAt` out.
  if (paymentOf(form) === 'prepaid' && (finishedAt || form.status === 'READY_FOR_PROCESSING')) {
    facts.push({ id: `${form.id}:paid`, type: 'paid', occurredAt: finishedAt ?? changedAtOf(form), note: null })
  }
  const fulfillment = form.fulfillment?.status ?? null
  if (fulfillment !== null && SHIPPED_FULFILLMENT_STATUSES.includes(fulfillment)) {
    facts.push({ id: `${form.id}:shipped`, type: 'shipped', occurredAt: changedAtOf(form), note: null })
  }
  if (form.status === 'CANCELLED' || fulfillment === 'CANCELLED') {
    facts.push({ id: `${form.id}:cancelled`, type: 'cancelled', occurredAt: changedAtOf(form), note: null })
  }
  // A stable sort: facts at the same moment keep the order paid, shipped, cancelled.
  return facts.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
}

function linesOf(form: CheckoutForm): OrderLine[] {
  const currency = form.summary.totalToPay.currency.toUpperCase()
  return form.lineItems.map((item, index) => {
    if (item.price.currency.toUpperCase() !== currency) {
      throw new PermanentError(
        `Allegro checkout form ${form.id} cannot be mapped to an Order: ` +
          `lineItems.${index}.price.currency differs from summary.totalToPay.currency`,
      )
    }
    return {
      externalId: item.id,
      offerExternalId: item.offer.id,
      sku: text(item.offer.external?.id),
      name: item.offer.name,
      quantity: item.quantity,
      unitPrice: { amount: item.price.amount, currency },
    }
  })
}

function unmappable(form: CheckoutForm, what: string, error: Parameters<typeof issuePaths>[0]): PermanentError {
  return new PermanentError(`Allegro checkout form ${form.id} cannot be mapped to an ${what} (${issuePaths(error)})`, {
    cause: error,
  })
}

/**
 * A checkout form as a full canonical Order. Throws `PermanentError` (form id and field paths only) when the form
 * cannot be one: no address to ship to, a line in another currency than the total, a value the schema refuses.
 */
export function mapOrder(form: CheckoutForm): Order {
  const shippingAddress = shippingAddressOf(form)
  if (!shippingAddress) {
    throw new PermanentError(`Allegro checkout form ${form.id} has no address to ship to (delivery.address, buyer.address)`)
  }
  const payment = paymentOf(form)
  const facts = factsOf(form)
  const awaitingPayment =
    payment === 'prepaid' && UNPAID_STATUSES.includes(form.status) && !facts.some((fact) => fact.type === 'paid')
  const total = form.summary.totalToPay
  const candidate = {
    externalId: form.id,
    placedAt: placedAtOf(form),
    payment,
    awaitingPayment,
    total: { amount: total.amount, currency: total.currency.toUpperCase() },
    buyer: {
      name: buyerNameOf(form) ?? '',
      email: text(form.buyer.email),
      phone: text(form.buyer.phoneNumber) ?? text(form.delivery?.address?.phoneNumber),
      login: text(form.buyer.login),
    },
    shippingAddress,
    billingAddress: billingAddressOf(form),
    lines: linesOf(form),
    facts,
  }
  const parsed = orderSchema.safeParse(candidate)
  if (!parsed.success) throw unmappable(form, 'Order', parsed.error)
  return parsed.data
}

/**
 * A checkout form as an Order update: its facts, plus the shipping and billing addresses once the form is paid
 * (`READY_FOR_PROCESSING`), when Allegro has revealed the delivery address. For an Order placed before the feed's
 * boundary, which the core applies only if it imported that Order.
 */
export function mapOrderUpdate(form: CheckoutForm): OrderUpdate {
  const candidate: OrderUpdate = { kind: 'update', externalId: form.id, facts: factsOf(form) }
  if (form.status === 'READY_FOR_PROCESSING') {
    const shippingAddress = shippingAddressOf(form)
    if (shippingAddress) candidate.shippingAddress = shippingAddress
    candidate.billingAddress = billingAddressOf(form)
  }
  const parsed = orderUpdateSchema.safeParse(candidate)
  if (!parsed.success) throw unmappable(form, 'Order update', parsed.error)
  return parsed.data
}

/** A checkout form Allegro no longer has (404): merged into another one, so the Order is cancelled. */
export function removedOrderUpdate(formId: string, occurredAt: string): OrderUpdate {
  const candidate = {
    kind: 'update' as const,
    externalId: formId,
    facts: [
      { id: `${formId}:removed`, type: 'cancelled' as const, occurredAt, note: 'Merged into another order on the Channel' },
    ],
  }
  const parsed = orderUpdateSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new PermanentError(`Removed Allegro checkout form ${formId} cannot be an Order update (${issuePaths(parsed.error)})`, {
      cause: parsed.error,
    })
  }
  return parsed.data
}
