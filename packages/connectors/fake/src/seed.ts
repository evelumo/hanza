import type { Address, Buyer, ChannelFact, Offer, Order, OrderLine } from '@hanza/connector-sdk'

const buyer: Buyer = { name: 'John Test', email: 'john.test@example.com', phone: null, login: 'john_test' }

const shippingAddress: Address = {
  name: 'John Test',
  company: null,
  street: '1 Example Street',
  postalCode: '00-001',
  city: 'Warsaw',
  countryCode: 'PL',
  phone: null,
  taxId: null,
}

/**
 * The phone of the seed Buyers whose Order goes to a pickup point: a number no subscriber has. A locker Carrier
 * texts the pickup code, so it takes no parcel without one (the fake Carrier's pickup point service included).
 */
export const SEED_PHONE = '+48 000 000 000'

const pln = (amount: string) => ({ amount, currency: 'PLN' })

export const seedOffers: Offer[] = [
  { externalId: 'fake-offer-1', sku: 'FAKE-SKU-1', name: 'Ceramic mug', url: null, price: pln('39.99'), status: 'active' },
  { externalId: 'fake-offer-2', sku: 'FAKE-SKU-2', name: 'Cotton T-shirt M', url: null, price: pln('59.00'), status: 'active' },
  { externalId: 'fake-offer-3', sku: 'FAKE-SKU-3', name: 'Poster A3', url: null, price: pln('25.00'), status: 'active' },
  { externalId: 'fake-offer-4', sku: null, name: 'Sticker set', url: null, price: pln('5.50'), status: 'active' },
  // No price reported: the Channel's currency for this Offer is unknown, so Hanza never pushes a price to it.
  { externalId: 'fake-offer-5', sku: 'FAKE-SKU-5', name: 'Linen tote bag', url: null, price: null, status: 'active' },
]

function order(
  externalId: string,
  placedAt: string,
  payment: Order['payment'],
  total: string,
  lines: OrderLine[],
  delivery?: Order['delivery'],
  phone: string | null = null,
): Order {
  return {
    externalId,
    placedAt,
    payment,
    total: pln(total),
    buyer: { ...buyer, phone },
    shippingAddress: { ...shippingAddress, phone },
    billingAddress: null,
    ...(delivery ? { delivery: structuredClone(delivery) } : {}),
    lines,
    facts: [],
  }
}

// Delivery: two Orders to a pickup point, one by courier, and one (fake-order-3) from a Channel that does not say.
// The two that go to a pickup point have a phone, as a Channel asks for one there; the others have none, so
// fake-order-3 shows what a Carrier answers to a pickup point request without a phone.
export const seedOrders: Order[] = [
  order('fake-order-1', '2026-10-01T09:00:00Z', 'prepaid', '79.98', [
    { externalId: 'l1', offerExternalId: 'fake-offer-1', sku: 'FAKE-SKU-1', name: 'Ceramic mug', quantity: 2, unitPrice: pln('39.99') },
  ], { method: 'Parcel locker', pickupPoint: { id: 'FAKE01', name: 'Fake locker FAKE01, 5 Locker Street, Warsaw' } }, SEED_PHONE),
  order('fake-order-2', '2026-10-01T10:00:00Z', 'cash_on_delivery', '84.00', [
    { externalId: 'l1', offerExternalId: 'fake-offer-2', sku: 'FAKE-SKU-2', name: 'Cotton T-shirt M', quantity: 1, unitPrice: pln('59.00') },
    { externalId: 'l2', offerExternalId: 'fake-offer-3', sku: 'FAKE-SKU-3', name: 'Poster A3', quantity: 1, unitPrice: pln('25.00') },
  ], { method: 'Courier, cash on delivery', pickupPoint: null }),
  order('fake-order-3', '2026-10-01T11:00:00Z', 'prepaid', '10.00', [
    { externalId: 'l1', offerExternalId: null, sku: 'UNKNOWN-SKU', name: 'Product not in the catalogue', quantity: 1, unitPrice: pln('10.00') },
  ]),
  order('fake-order-4', '2026-10-01T12:00:00Z', 'prepaid', '16.50', [
    { externalId: 'l1', offerExternalId: 'fake-offer-4', sku: null, name: 'Sticker set', quantity: 3, unitPrice: pln('5.50') },
  ], { method: 'Parcel locker', pickupPoint: { id: 'FAKE02', name: 'Fake locker FAKE02, 12 Market Square, Krakow' } }, SEED_PHONE),
]

export const seedFacts: Array<{ orderExternalId: string; fact: ChannelFact }> = [
  {
    orderExternalId: 'fake-order-2',
    fact: {
      id: 'fake-order-2:cancelled',
      type: 'cancelled',
      occurredAt: '2026-10-02T10:00:00Z',
      note: 'Cancelled by the buyer',
    },
  },
]
