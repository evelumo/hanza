import { addressSchema, orderSchema, orderUpdateSchema, PermanentError, type Address, type Order, type OrderUpdate } from '@hanza/connector-sdk'
import type { MedusaAddress, MedusaLineItem, MedusaOrder } from '../api'
import { divideDecimal, toMoneyAmount } from '../decimal'
import { amountOf, wholeNumberOf } from './amount'
import { isCashOnDelivery, orderFacts, type OrderRules } from './status'

const orNull = (value: string | null | undefined) => {
  const text = (value ?? '').trim()
  return text === '' ? null : text
}

function personName(address: MedusaAddress | null | undefined): string {
  if (!address) return ''
  return [address.first_name, address.last_name].map((part) => (part ?? '').trim()).filter((part) => part !== '').join(' ')
}

/** The address as the canonical one, or null when it lacks something the canonical address requires. */
export function mapAddress(address: MedusaAddress | null | undefined, fallbackPhone: string | null = null): Address | null {
  if (!address) return null
  const mapped = addressSchema.safeParse({
    name: personName(address) || (address.company ?? '').trim(),
    company: orNull(address.company),
    street: [address.address_1, address.address_2].map((part) => (part ?? '').trim()).filter((part) => part !== '').join(', '),
    postalCode: (address.postal_code ?? '').trim(),
    city: (address.city ?? '').trim(),
    countryCode: (address.country_code ?? '').trim().toUpperCase(),
    phone: orNull(address.phone) ?? fallbackPhone,
    // Medusa has no tax id on an address.
    taxId: null,
  })
  return mapped.success ? mapped.data : null
}

/** What the Buyer paid for one unit: the line's total (tax included, after discounts) over its quantity, exact, half-up to 4 places. */
export function unitPriceAmount(line: Pick<MedusaLineItem, 'raw_total' | 'total'>, quantity: number): string | null {
  const total = amountOf(line.raw_total, line.total)
  return total === null ? null : divideDecimal(total, quantity)
}

/** `problems` are field paths of the canonical Order (`lines`, `shippingAddress`, `lines.0.quantity`), never values. */
export type MappedOrder = { fits: true; order: Order } | { fits: false; externalId: string; problems: string[] }

// What an order's own data decides. A problem anywhere else (the id, a date, a fact) can only come from this mapper.
const DATA_PATHS = ['total', 'buyer', 'shippingAddress', 'billingAddress', 'lines', 'delivery']
// Hanza keeps a line's quantity in a 32-bit column, which `orderSchema` does not know.
const MAX_QUANTITY = 2_147_483_647

function customerPhone(order: MedusaOrder): string | null {
  return orNull(order.customer?.phone)
}

function lineName(line: MedusaLineItem): string {
  return (line.title ?? '').trim() || [line.product_title, line.variant_title].map((part) => (part ?? '').trim()).filter((part) => part !== '').join(' - ')
}

/**
 * The order as a full canonical Order, validated; or, for an order the canonical model cannot hold (no lines, a
 * fractional quantity, no usable shipping address, an amount that is not money), the paths that do not fit, so the
 * feed can skip it instead of failing its page. Throws a `PermanentError` only for a mapper bug.
 */
export function mapOrder(order: MedusaOrder, rules: OrderRules): MappedOrder {
  const currency = order.currency_code.trim().toUpperCase()
  const phone = customerPhone(order)
  const shipping = mapAddress(order.shipping_address, phone)
  const billing = mapAddress(order.billing_address, null)
  const facts = orderFacts(order, rules)
  const cashOnDelivery = isCashOnDelivery(order, rules)
  const total = amountOf(order.raw_total, order.total)
  const candidate = {
    externalId: order.id,
    placedAt: order.created_at,
    payment: cashOnDelivery ? 'cash_on_delivery' : 'prepaid',
    ...(!cashOnDelivery && !facts.some((fact) => fact.type === 'paid') ? { awaitingPayment: true } : {}),
    total: { amount: total === null ? '' : (toMoneyAmount(total) ?? ''), currency },
    buyer: {
      name: personName(order.shipping_address) || (order.shipping_address?.company ?? '').trim() || personName(order.billing_address) || (order.email ?? '').trim(),
      email: orNull(order.email),
      phone: orNull(order.shipping_address?.phone) ?? phone,
      login: null,
    },
    shippingAddress: shipping ?? undefined,
    billingAddress: billing,
    delivery: { method: orNull(order.shipping_methods?.[0]?.name), pickupPoint: null },
    lines: (order.items ?? []).map((line) => {
      const quantity = wholeNumberOf(line.raw_quantity, line.quantity)
      return {
        externalId: line.id,
        offerExternalId: orNull(line.variant_id),
        sku: orNull(line.variant_sku),
        name: lineName(line),
        quantity: quantity ?? Number.NaN,
        unitPrice: { amount: quantity === null || quantity <= 0 ? '' : (unitPriceAmount(line, quantity) ?? ''), currency },
      }
    }),
    facts,
  }
  const mapped = orderSchema.safeParse(candidate)
  if (mapped.success) {
    const tooMany = mapped.data.lines.flatMap((line, index) => (line.quantity > MAX_QUANTITY ? [`lines.${index}.quantity`] : []))
    return tooMany.length === 0 ? { fits: true, order: mapped.data } : { fits: false, externalId: order.id, problems: tooMany }
  }
  const problems = [...new Set(mapped.error.issues.map((issue) => issue.path.join('.')))]
  const bugs = problems.filter((path) => !DATA_PATHS.includes(path.split('.')[0] ?? ''))
  if (bugs.length > 0) throw new PermanentError(`Order ${order.id} was mapped to an invalid canonical Order: ${bugs.join(', ')}`, { cause: mapped.error })
  return { fits: false, externalId: order.id, problems }
}

/**
 * The order's facts and addresses as an Order update: for an order placed before the feed's boundary, a closed order
 * of the listing, or a closed one that does not fit. A shipping address that does not fit is left out (unchanged).
 */
export function mapOrderUpdate(order: MedusaOrder, rules: OrderRules): OrderUpdate {
  const shipping = mapAddress(order.shipping_address, customerPhone(order))
  const candidate = {
    kind: 'update' as const,
    externalId: order.id,
    facts: orderFacts(order, rules),
    ...(shipping === null ? {} : { shippingAddress: shipping }),
    // As in a full Order: an incomplete billing address is none.
    billingAddress: mapAddress(order.billing_address),
  }
  const mapped = orderUpdateSchema.safeParse(candidate)
  if (!mapped.success) {
    throw new PermanentError(`Order ${order.id} was mapped to an invalid Order update: ${mapped.error.issues.map((issue) => issue.path.join('.')).join(', ')}`, {
      cause: mapped.error,
    })
  }
  return mapped.data
}
