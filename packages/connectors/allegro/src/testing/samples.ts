import type { z } from 'zod'
import type { orderEventSchema } from '../api/events'
import type { listingOfferSchema, productOfferSchema } from '../api/offers'
import type { checkoutFormSchema } from '../api/orders'

// Realistic but fictitious Allegro payloads, shaped like the OpenAPI examples (swagger.yaml). Every person, address,
// e-mail, phone and tax id here is made up. They carry fields the connector does not model (`personalIdentity`,
// `messageToSeller`, surcharges, delivery cost, ...) on purpose: the schemas must strip them.
// Overrides are shallow: replace a nested object whole (`{ ...base.buyer, firstName: undefined }`).

export type ListingOfferPayload = z.input<typeof listingOfferSchema>
export type ProductOfferPayload = z.input<typeof productOfferSchema>
export type CheckoutFormPayload = z.input<typeof checkoutFormSchema>
export type OrderEventPayload = z.input<typeof orderEventSchema>

const SELLER_ID = '43784832'

export function sampleListingOffer(overrides: Partial<ListingOfferPayload> = {}): ListingOfferPayload {
  const unmodelled = {
    category: { id: '257929' },
    primaryImage: { url: 'https://a.allegroimg.com/original/05a2af/929c6dae4fb8721a8539582eb421' },
    saleInfo: { currentPrice: null, biddersCount: 0 },
    stats: { watchersCount: 4, visitsCount: 54 },
  }
  return {
    id: '7834566001',
    name: 'Ceramic mug 350 ml, white',
    ...unmodelled,
    sellingMode: { format: 'BUY_NOW', price: { amount: '39.99', currency: 'PLN' } },
    stock: { available: 23, ...{ sold: 3 } },
    // The listing's publication has no `endedBy` (confirmed on the sandbox): only the product-offer resource tells it.
    publication: {
      status: 'ACTIVE',
      ...{ startingAt: null, startedAt: '2026-09-01T08:00:00Z', endingAt: null, endedAt: null, marketplaces: { base: { id: 'allegro-pl' } } },
    },
    external: { id: 'MUG-350-WHT' },
    isFulfillment: false,
    ...overrides,
  }
}

export function sampleProductOffer(overrides: Partial<ProductOfferPayload> = {}): ProductOfferPayload {
  const unmodelled = { name: 'Ceramic mug 350 ml, white', language: 'pl-PL', category: { id: '257929' } }
  return {
    id: '7834566001',
    ...unmodelled,
    publication: { status: 'ACTIVE', endedBy: null, ...{ republish: false, startingAt: null } },
    stock: { available: 23, ...{ unit: 'UNIT' } },
    ...overrides,
  }
}

const buyerAddress = { street: 'Półwiejska 12/4', city: 'Poznań', postCode: '61-888', countryCode: 'PL' }

const deliveryAddress = {
  firstName: 'Anna',
  lastName: 'Kowalska',
  street: 'Półwiejska 12/4',
  city: 'Poznań',
  zipCode: '61-888',
  countryCode: 'PL',
  phoneNumber: '+48 600 000 001',
  ...{ modifiedAt: '2026-10-01T09:05:00.000Z' },
}

export function sampleCheckoutForm(overrides: Partial<CheckoutFormPayload> = {}): CheckoutFormPayload {
  // Never mapped: the PESEL and the Buyer's free text (ADR 0016). Present so tests prove they are dropped.
  const sensitive = { personalIdentity: '90010112345', preferences: { language: 'pl-PL' } }
  const unmodelled = {
    messageToSeller: 'Please wrap it as a gift',
    surcharges: [],
    note: { text: 'Seller note' },
  }
  return {
    id: '29738e61-c4e8-11f1-89db-60ede9d61a01',
    ...unmodelled,
    buyer: {
      id: '23123123',
      email: 'anna.kowalska@example.com',
      login: 'anna_k_test',
      firstName: 'Anna',
      lastName: 'Kowalska',
      guest: false,
      phoneNumber: '+48 600 000 001',
      address: buyerAddress,
      ...sensitive,
    },
    payment: {
      type: 'ONLINE',
      finishedAt: '2026-10-01T09:10:00.000Z',
      paidAmount: { amount: '94.97', currency: 'PLN' },
      ...{ id: '0f8f1d13-7e9e-41e8-9b00-c5b0dfb78ea6', provider: 'P24' },
    },
    status: 'READY_FOR_PROCESSING',
    fulfillment: { status: 'NEW', provider: { id: 'SELLER' }, ...{ shipmentSummary: { lineItemsSent: 'NONE' } } },
    delivery: {
      address: deliveryAddress,
      method: { id: '1fa56f79-4b6a-4821-a6f2-ca9c16d5c925', name: 'Allegro Kurier DPD' },
      ...{ cost: { amount: '14.99', currency: 'PLN' }, smart: false, calculatedNumberOfPackages: 1 },
    },
    invoice: { required: false },
    lineItems: [
      {
        id: '62ae358b-c4e8-11f1-9c77-bedf604a2e01',
        offer: { id: '7834566001', name: 'Ceramic mug 350 ml, white', external: { id: 'MUG-350-WHT' } },
        quantity: 2,
        originalPrice: { amount: '39.99', currency: 'PLN' },
        price: { amount: '39.99', currency: 'PLN' },
        boughtAt: '2026-10-01T09:00:00.000Z',
      },
    ],
    // 2 x 39.99 + 14.99 delivery.
    summary: { totalToPay: { amount: '94.97', currency: 'PLN' } },
    marketplace: { id: 'allegro-pl' },
    updatedAt: '2026-10-01T09:10:05.000Z',
    revision: '819b5836',
    ...overrides,
  }
}

export function sampleOrderEvent(overrides: Partial<OrderEventPayload> = {}): OrderEventPayload {
  // The event's buyer and line items are a snapshot the connector does not read.
  const unmodelled = {
    seller: { id: SELLER_ID },
    buyer: { id: '23123123', email: 'anna.kowalska@example.com', login: 'anna_k_test', guest: false },
    lineItems: [],
    marketplace: { id: 'allegro-pl' },
  }
  return {
    id: '1791663869066571',
    type: 'READY_FOR_PROCESSING',
    occurredAt: '2026-10-01T09:10:05.000Z',
    order: {
      ...unmodelled,
      checkoutForm: { id: '29738e61-c4e8-11f1-89db-60ede9d61a01', revision: '819b5836' },
    },
    ...overrides,
  }
}

const base = sampleCheckoutForm()
const baseLine = base.lineItems[0]!

function formId(suffix: string): string {
  return `29738e61-c4e8-11f1-89db-60ede9d6${suffix}`
}

/** One scenario per mapping rule. Ids differ so a simulation can serve them side by side. */
export const forms = {
  /** Paid online, ready to fulfil. */
  paidOnline: sampleCheckoutForm({ id: formId('1a02') }),

  cashOnDelivery: sampleCheckoutForm({
    id: formId('1a03'),
    payment: { type: 'CASH_ON_DELIVERY', paidAmount: null, ...{ id: '0f8f1d13-7e9e-41e8-9b00-c5b0dfb78e03' } },
  }),

  /** A company invoice with several tax ids: the PL NIP wins. */
  companyInvoice: sampleCheckoutForm({
    id: formId('1a04'),
    buyer: { ...base.buyer, companyName: 'Kowalska Ceramika Sp. z o.o.' },
    invoice: {
      required: true,
      address: {
        street: 'Święty Marcin 29',
        city: 'Poznań',
        zipCode: '61-806',
        countryCode: 'pl',
        company: {
          name: 'Kowalska Ceramika Sp. z o.o.',
          ids: [
            { type: 'VAT_EU', value: 'PL1234563218' },
            { type: 'PL_NIP', value: '1234563218' },
          ],
          ...{ vatPayerStatus: 'ACTIVE' },
        },
        naturalPerson: null,
      },
    },
  }),

  /** A private invoice: no company, the person's name. */
  personalInvoice: sampleCheckoutForm({
    id: formId('1a05'),
    invoice: {
      required: true,
      address: {
        street: 'Półwiejska 12/4',
        city: 'Poznań',
        zipCode: '61-888',
        countryCode: 'PL',
        company: null,
        naturalPerson: { firstName: 'Anna', lastName: 'Kowalska' },
      },
    },
  }),

  /** Delivery to a parcel locker: the pickup point is not mapped, the delivery address is. */
  pickupPoint: sampleCheckoutForm({
    id: formId('1a06'),
    delivery: {
      address: deliveryAddress,
      method: { id: '2488f7b7-5d1c-4d65-b85c-4cbcf253fd93', name: 'Allegro Paczkomaty InPost' },
      pickupPoint: {
        id: 'POZ08A',
        ...{
          name: 'Paczkomat POZ08A',
          description: 'Fuel station',
          address: { street: 'Grunwaldzka 108', zipCode: '60-166', city: 'Poznań', countryCode: 'PL' },
        },
      },
    },
  }),

  /** Two lines bought at different times: `placedAt` is the earlier one. */
  multiLine: sampleCheckoutForm({
    id: formId('1a07'),
    lineItems: [
      { ...baseLine, id: '62ae358b-c4e8-11f1-9c77-bedf604a2e07', boughtAt: '2026-10-01T09:02:00.000Z' },
      {
        id: '62ae358b-c4e8-11f1-9c77-bedf604a2e08',
        offer: { id: '7834566002', name: 'Teapot 1 l, blue glaze' },
        quantity: 1,
        originalPrice: { amount: '129.00', currency: 'PLN' },
        price: { amount: '119.90', currency: 'PLN' },
        boughtAt: '2026-10-01T08:58:30.000Z',
      },
    ],
    // 2 x 39.99 + 119.90 + 14.99 delivery.
    summary: { totalToPay: { amount: '214.87', currency: 'PLN' } },
  }),

  /** No first and last name, no company: the login is the name. */
  buyerWithoutName: sampleCheckoutForm({
    id: formId('1a09'),
    buyer: { ...base.buyer, firstName: undefined, lastName: undefined, companyName: undefined },
    delivery: { address: { ...deliveryAddress, firstName: '', lastName: '' } },
  }),

  /** Paid, then cancelled by the Buyer. */
  cancelledAfterPayment: sampleCheckoutForm({
    id: formId('1a10'),
    status: 'CANCELLED',
    updatedAt: '2026-10-02T11:00:00.000Z',
  }),

  /** Never paid; Allegro cancelled it. */
  autoCancelledUnpaid: sampleCheckoutForm({
    id: formId('1a11'),
    status: 'CANCELLED',
    payment: { type: 'ONLINE', ...{ id: '0f8f1d13-7e9e-41e8-9b00-c5b0dfb78e11' } },
    updatedAt: '2026-10-08T09:00:00.000Z',
  }),

  /** Checkout form filled in, payment not finished: awaiting payment. */
  filledInUnpaid: sampleCheckoutForm({
    id: formId('1a12'),
    status: 'FILLED_IN',
    payment: { type: 'ONLINE', ...{ id: '0f8f1d13-7e9e-41e8-9b00-c5b0dfb78e12' } },
    updatedAt: '2026-10-01T09:03:00.000Z',
  }),

  /** Bought, nothing filled in, no account address: no address to ship to yet. */
  boughtNoAddress: sampleCheckoutForm({
    id: formId('1a13'),
    status: 'BOUGHT',
    buyer: { ...base.buyer, address: null },
    payment: null,
    delivery: null,
    updatedAt: '2026-10-01T09:00:01.000Z',
  }),

  /** Bought, nothing filled in, but the Buyer's account has an address. */
  boughtAccountAddress: sampleCheckoutForm({
    id: formId('1a14'),
    status: 'BOUGHT',
    payment: null,
    delivery: null,
    updatedAt: '2026-10-01T09:00:01.000Z',
  }),

  sent: sampleCheckoutForm({
    id: formId('1a15'),
    fulfillment: { status: 'SENT', provider: { id: 'SELLER' } },
    updatedAt: '2026-10-02T15:30:00.000Z',
  }),

  sellerCancelled: sampleCheckoutForm({
    id: formId('1a16'),
    fulfillment: { status: 'CANCELLED', provider: { id: 'SELLER' } },
    updatedAt: '2026-10-02T08:00:00.000Z',
  }),

  /** Bought on allegro.cz: everything in CZK. */
  allegroCz: sampleCheckoutForm({
    id: formId('1a17'),
    buyer: {
      ...base.buyer,
      firstName: 'Jana',
      lastName: 'Nováková',
      email: 'jana.novakova@example.com',
      login: 'jana_n_test',
      phoneNumber: '+420 600 000 001',
      address: { street: 'Masarykova 1', city: 'Brno', postCode: '602 00', countryCode: 'CZ' },
    },
    payment: {
      type: 'ONLINE',
      finishedAt: '2026-10-01T09:10:00.000Z',
      paidAmount: { amount: '1089.00', currency: 'CZK' },
      ...{ id: '0f8f1d13-7e9e-41e8-9b00-c5b0dfb78e17' },
    },
    delivery: {
      address: {
        firstName: 'Jana',
        lastName: 'Nováková',
        street: 'Masarykova 1',
        city: 'Brno',
        zipCode: '602 00',
        countryCode: 'CZ',
        phoneNumber: '+420 600 000 001',
      },
    },
    lineItems: [
      {
        ...baseLine,
        id: '62ae358b-c4e8-11f1-9c77-bedf604a2e17',
        quantity: 1,
        originalPrice: { amount: '990.00', currency: 'CZK' },
        price: { amount: '990.00', currency: 'CZK' },
      },
    ],
    summary: { totalToPay: { amount: '1089.00', currency: 'CZK' } },
    marketplace: { id: 'allegro-cz' },
  }),

  /** Fulfilled by Allegro's warehouse: skipped. */
  oneFulfillment: sampleCheckoutForm({
    id: formId('1a18'),
    fulfillment: { status: 'NEW', provider: { id: 'ALLEGRO' } },
  }),
} satisfies Record<string, CheckoutFormPayload>

/** One scenario per Offer mapping rule. */
export const offers = {
  buyNow: sampleListingOffer(),

  auction: sampleListingOffer({
    id: '7834566003',
    name: 'Vintage tea set, 12 pieces',
    sellingMode: {
      format: 'AUCTION',
      price: { amount: '150.00', currency: 'PLN' },
      ...{ startingPrice: { amount: '50.00', currency: 'PLN' } },
    },
    stock: { available: 1 },
    external: null,
  }),

  /** Ended because its stock reached 0: `GET /sale/product-offers/{id}` says `EMPTY_STOCK`. */
  endedSoldOut: sampleListingOffer({
    id: '7834566004',
    name: 'Espresso cup 90 ml, black',
    stock: { available: 0 },
    publication: { status: 'ENDED' },
    external: { id: 'CUP-090-BLK' },
  }),

  /** Ended by the seller with stock left: `other` without a lookup. */
  endedByUser: sampleListingOffer({
    id: '7834566005',
    name: 'Salad bowl 24 cm, grey',
    stock: { available: 5 },
    publication: { status: 'ENDED' },
    external: { id: 'BOWL-240-GRY' },
  }),

  /** No external id (SKU) set by the seller; a price without its trailing zero, as the sandbox lists some (`24.0`). */
  withoutSignature: sampleListingOffer({
    id: '7834566006',
    name: 'Stoneware plate 27 cm',
    sellingMode: { format: 'BUY_NOW', price: { amount: '24.0', currency: 'PLN' } },
    external: null,
  }),

  /** Fulfilled by Allegro's warehouse: skipped. */
  oneFulfillment: sampleListingOffer({ id: '7834566007', name: 'Milk jug 0.5 l', isFulfillment: true }),

  /** A draft never published. */
  draft: sampleListingOffer({
    id: '7834566008',
    name: 'Butter dish with lid',
    publication: { status: 'INACTIVE' },
    stock: { available: 10 },
  }),
} satisfies Record<string, ListingOfferPayload>

/** The product-offer answers that tell why the ended sample Offers ended. */
export const productOffers = {
  endedSoldOut: sampleProductOffer({
    id: '7834566004',
    publication: { status: 'ENDED', endedBy: 'EMPTY_STOCK' },
    stock: { available: 0 },
  }),
  endedByUser: sampleProductOffer({
    id: '7834566005',
    publication: { status: 'ENDED', endedBy: 'USER' },
    stock: { available: 5 },
  }),
} satisfies Record<string, ProductOfferPayload>
