import { orderSchema, PermanentError } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { checkoutFormSchema } from '../api/orders'
import type { CheckoutFormPayload } from '../testing/samples'
import { forms, sampleCheckoutForm } from '../testing/samples'
import {
  boundaryKeyOf,
  factsOf,
  hasUsableAddress,
  isOneFulfillment,
  mapOrder,
  mapOrderUpdate,
  placedAtOf,
  removedOrderUpdate,
} from './order'

function parse(payload: CheckoutFormPayload) {
  return checkoutFormSchema.parse(payload)
}

const base = sampleCheckoutForm()

const annaAddress = {
  name: 'Anna Kowalska',
  company: null,
  street: 'Półwiejska 12/4',
  postalCode: '61-888',
  city: 'Poznań',
  countryCode: 'PL',
  phone: '+48 600 000 001',
  taxId: null,
}

describe('mapOrder', () => {
  it('maps a form paid online', () => {
    const id = forms.paidOnline.id
    expect(mapOrder(parse(forms.paidOnline))).toEqual({
      externalId: id,
      placedAt: '2026-10-01T09:00:00.000Z',
      payment: 'prepaid',
      awaitingPayment: false,
      total: { amount: '94.97', currency: 'PLN' },
      buyer: { name: 'Anna Kowalska', email: 'anna.kowalska@example.com', phone: '+48 600 000 001', login: 'anna_k_test' },
      shippingAddress: annaAddress,
      billingAddress: null,
      lines: [
        {
          externalId: '62ae358b-c4e8-11f1-9c77-bedf604a2e01',
          offerExternalId: '7834566001',
          sku: 'MUG-350-WHT',
          name: 'Ceramic mug 350 ml, white',
          quantity: 2,
          unitPrice: { amount: '39.99', currency: 'PLN' },
        },
      ],
      facts: [{ id: `${id}:paid`, type: 'paid', occurredAt: '2026-10-01T09:10:00.000Z', note: null }],
    })
  })

  it('never carries the PESEL or the message to the seller', () => {
    const json = JSON.stringify(mapOrder(parse(sampleCheckoutForm())))
    expect(json).not.toContain('90010112345')
    expect(json).not.toContain('gift')
    expect(json).not.toContain('Seller note')
  })

  it('maps cash on delivery: no paid fact, never awaiting payment', () => {
    const order = mapOrder(parse(forms.cashOnDelivery))
    expect(order.payment).toBe('cash_on_delivery')
    expect(order.awaitingPayment).toBe(false)
    expect(order.facts).toEqual([])
  })

  it('maps a cash-on-delivery form even when Allegro sets finishedAt on it', () => {
    const payload = sampleCheckoutForm({ payment: { type: 'CASH_ON_DELIVERY', finishedAt: '2026-10-03T12:00:00.000Z' } })
    expect(mapOrder(parse(payload)).facts).toEqual([])
  })

  it.each(['WIRE_TRANSFER', 'SPLIT_PAYMENT', 'EXTENDED_TERM', 'A_NEW_TYPE'])('maps the payment type %s to prepaid', (type) => {
    expect(mapOrder(parse(sampleCheckoutForm({ payment: { type } }))).payment).toBe('prepaid')
  })

  it('maps a form with no payment to prepaid', () => {
    expect(mapOrder(parse(sampleCheckoutForm({ payment: null }))).payment).toBe('prepaid')
  })

  it('maps a company invoice with its PL NIP preferred over the EU VAT number', () => {
    const order = mapOrder(parse(forms.companyInvoice))
    expect(order.billingAddress).toEqual({
      name: 'Kowalska Ceramika Sp. z o.o.',
      company: 'Kowalska Ceramika Sp. z o.o.',
      street: 'Święty Marcin 29',
      postalCode: '61-806',
      city: 'Poznań',
      countryCode: 'PL',
      phone: null,
      taxId: '1234563218',
    })
    expect(order.buyer.name).toBe('Anna Kowalska')
  })

  it.each([
    [
      'the EU VAT number without a PL NIP',
      [{ type: 'CZ_ICO', value: '12345678' }, { type: 'VAT_EU', value: 'PL1234563218' }],
      'PL1234563218',
    ],
    ['the first id without either', [{ type: 'CZ_ICO', value: '12345678' }, { type: 'OTHER', value: '999' }], '12345678'],
    ['null without ids', [], null],
  ])('takes %s as the tax id', (_label, ids, taxId) => {
    const invoice = forms.companyInvoice.invoice!
    const payload = sampleCheckoutForm({
      invoice: { ...invoice, address: { ...invoice.address!, company: { name: 'Kowalska Ceramika Sp. z o.o.', ids } } },
    })
    expect(mapOrder(parse(payload)).billingAddress?.taxId).toBe(taxId)
  })

  it('maps a private invoice to the natural person', () => {
    expect(mapOrder(parse(forms.personalInvoice)).billingAddress).toEqual({ ...annaAddress, phone: null })
  })

  it('has no billing address when no invoice is required, even with an invoice address', () => {
    const payload = sampleCheckoutForm({ invoice: { ...forms.companyInvoice.invoice!, required: false } })
    expect(mapOrder(parse(payload)).billingAddress).toBeNull()
  })

  it('ships to the delivery address of a pickup point Order, not to the point', () => {
    const order = mapOrder(parse(forms.pickupPoint))
    expect(order.shippingAddress).toEqual(annaAddress)
    expect(JSON.stringify(order)).not.toContain('POZ08A')
  })

  it('maps several lines, with placedAt the earliest purchase', () => {
    const order = mapOrder(parse(forms.multiLine))
    expect(order.placedAt).toBe('2026-10-01T08:58:30.000Z')
    expect(order.total).toEqual({ amount: '214.87', currency: 'PLN' })
    expect(order.lines).toEqual([
      expect.objectContaining({ offerExternalId: '7834566001', quantity: 2, unitPrice: { amount: '39.99', currency: 'PLN' } }),
      expect.objectContaining({
        externalId: '62ae358b-c4e8-11f1-9c77-bedf604a2e08',
        offerExternalId: '7834566002',
        sku: null,
        name: 'Teapot 1 l, blue glaze',
        quantity: 1,
        unitPrice: { amount: '119.90', currency: 'PLN' },
      }),
    ])
  })

  describe('the Buyer name', () => {
    it('is the first and last name', () => {
      expect(mapOrder(parse(forms.paidOnline)).buyer.name).toBe('Anna Kowalska')
    })

    it('is the company name without a person name', () => {
      const payload = sampleCheckoutForm({
        buyer: { ...base.buyer, firstName: undefined, lastName: undefined, companyName: 'Kowalska Ceramika Sp. z o.o.' },
      })
      expect(mapOrder(parse(payload)).buyer.name).toBe('Kowalska Ceramika Sp. z o.o.')
    })

    it('is the login without either, also on the shipping address with no receiver name', () => {
      const order = mapOrder(parse(forms.buyerWithoutName))
      expect(order.buyer.name).toBe('anna_k_test')
      expect(order.shippingAddress.name).toBe('anna_k_test')
    })

    it('takes the receiver company when the delivery address has no person name', () => {
      const payload = sampleCheckoutForm({
        delivery: {
          address: { ...forms.pickupPoint.delivery!.address!, firstName: null, lastName: null, companyName: 'Kowalska Ceramika' },
        },
      })
      const address = mapOrder(parse(payload)).shippingAddress
      expect(address.name).toBe('Kowalska Ceramika')
      expect(address.company).toBe('Kowalska Ceramika')
    })

    it('fails permanently with no name at all', () => {
      const payload = sampleCheckoutForm({
        buyer: { ...base.buyer, firstName: undefined, lastName: undefined, login: undefined },
      })
      expect(() => mapOrder(parse(payload))).toThrow(PermanentError)
    })
  })

  it('takes the Buyer phone from the delivery address when the account has none', () => {
    const order = mapOrder(parse(sampleCheckoutForm({ buyer: { ...base.buyer, phoneNumber: undefined } })))
    expect(order.buyer.phone).toBe('+48 600 000 001')
    const none = sampleCheckoutForm({
      buyer: { ...base.buyer, phoneNumber: undefined },
      delivery: { address: { ...forms.paidOnline.delivery!.address!, phoneNumber: undefined } },
    })
    expect(mapOrder(parse(none)).buyer.phone).toBeNull()
  })

  it('maps a form paid then cancelled: paid, then cancelled', () => {
    const id = forms.cancelledAfterPayment.id
    const order = mapOrder(parse(forms.cancelledAfterPayment))
    expect(order.awaitingPayment).toBe(false)
    expect(order.facts).toEqual([
      { id: `${id}:paid`, type: 'paid', occurredAt: '2026-10-01T09:10:00.000Z', note: null },
      { id: `${id}:cancelled`, type: 'cancelled', occurredAt: '2026-10-02T11:00:00.000Z', note: null },
    ])
  })

  it('maps a form Allegro cancelled unpaid: cancelled, not awaiting payment', () => {
    const order = mapOrder(parse(forms.autoCancelledUnpaid))
    expect(order.awaitingPayment).toBe(false)
    expect(order.facts).toEqual([
      { id: `${forms.autoCancelledUnpaid.id}:cancelled`, type: 'cancelled', occurredAt: '2026-10-08T09:00:00.000Z', note: null },
    ])
  })

  it('maps a filled-in, unpaid form as awaiting payment', () => {
    const order = mapOrder(parse(forms.filledInUnpaid))
    expect(order.awaitingPayment).toBe(true)
    expect(order.facts).toEqual([])
    expect(order.shippingAddress).toEqual(annaAddress)
    expect(orderSchema.safeParse(order).success).toBe(true)
  })

  it('never sends awaitingPayment next to a paid fact', () => {
    const payload = sampleCheckoutForm({ status: 'FILLED_IN' })
    const order = mapOrder(parse(payload))
    expect(order.facts.map((fact) => fact.type)).toEqual(['paid'])
    expect(order.awaitingPayment).toBe(false)
  })

  it('maps a bought form to the account address, awaiting payment', () => {
    const order = mapOrder(parse(forms.boughtAccountAddress))
    expect(order.awaitingPayment).toBe(true)
    expect(order.shippingAddress).toEqual({ ...annaAddress, postalCode: '61-888' })
  })

  it('fails permanently for a form with no address to ship to', () => {
    expect(() => mapOrder(parse(forms.boughtNoAddress))).toThrow(PermanentError)
    expect(() => mapOrder(parse(forms.boughtNoAddress))).toThrow(forms.boughtNoAddress.id)
  })

  it('maps a sent form: paid, then shipped', () => {
    const id = forms.sent.id
    expect(mapOrder(parse(forms.sent)).facts).toEqual([
      { id: `${id}:paid`, type: 'paid', occurredAt: '2026-10-01T09:10:00.000Z', note: null },
      { id: `${id}:shipped`, type: 'shipped', occurredAt: '2026-10-02T15:30:00.000Z', note: null },
    ])
  })

  it('maps a form the seller cancelled: paid, then cancelled', () => {
    const id = forms.sellerCancelled.id
    expect(mapOrder(parse(forms.sellerCancelled)).facts.map((fact) => fact.id)).toEqual([`${id}:paid`, `${id}:cancelled`])
  })

  it('maps an allegro.cz Order in CZK', () => {
    const order = mapOrder(parse(forms.allegroCz))
    expect(order.total).toEqual({ amount: '1089.00', currency: 'CZK' })
    expect(order.lines[0]?.unitPrice).toEqual({ amount: '990.00', currency: 'CZK' })
    expect(order.shippingAddress).toMatchObject({ name: 'Jana Nováková', postalCode: '602 00', countryCode: 'CZ' })
  })

  it('upper-cases currencies and country codes', () => {
    const order = mapOrder(parse(sampleCheckoutForm({
      summary: { totalToPay: { amount: '94.97', currency: 'pln' } },
      delivery: { address: { ...forms.paidOnline.delivery!.address!, countryCode: 'pl' } },
    })))
    expect(order.total.currency).toBe('PLN')
    expect(order.lines[0]?.unitPrice.currency).toBe('PLN')
    expect(order.shippingAddress.countryCode).toBe('PL')
  })

  it('fails permanently, naming the form and the field, for a line in another currency than the total', () => {
    const payload = forms.multiLine
    const lines = [payload.lineItems[0]!, { ...payload.lineItems[1]!, price: { amount: '27.50', currency: 'EUR' } }]
    const run = () => mapOrder(parse({ ...payload, lineItems: lines }))
    expect(run).toThrow(PermanentError)
    expect(run).toThrow(`Allegro checkout form ${payload.id} cannot be mapped to an Order: lineItems.1.price.currency`)
  })

  it('fails permanently with field paths only for an amount the canonical Money refuses', () => {
    const payload = sampleCheckoutForm({ summary: { totalToPay: { amount: '94.97001', currency: 'PLN' } } })
    let error: unknown
    try {
      mapOrder(parse(payload))
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(PermanentError)
    expect((error as Error).message).toBe(`Allegro checkout form ${payload.id} cannot be mapped to an Order (total.amount)`)
  })

  it('does not put Buyer data in the message of a schema failure', () => {
    const payload = sampleCheckoutForm({ delivery: { address: { ...forms.paidOnline.delivery!.address!, countryCode: 'POL' } } })
    expect(() => mapOrder(parse(payload))).toThrow(/\(shippingAddress\.countryCode\)$/)
    try {
      mapOrder(parse(payload))
    } catch (error) {
      expect((error as Error).message).not.toMatch(/Kowalska|Półwiejska|example\.com|POL/)
    }
  })
})

describe('boundaryKeyOf', () => {
  it('is the latest boughtAt, while placedAt stays the earliest', () => {
    const form = parse(forms.multiLine)
    expect(boundaryKeyOf(form)).toBe('2026-10-01T09:02:00.000Z')
    expect(mapOrder(form).placedAt).toBe('2026-10-01T08:58:30.000Z')
  })

  it('falls back to updatedAt without any boughtAt', () => {
    const lines = [{ ...base.lineItems[0]!, boughtAt: undefined }]
    expect(boundaryKeyOf(parse(sampleCheckoutForm({ lineItems: lines })))).toBe('2026-10-01T09:10:05.000Z')
  })
})

describe('placedAtOf', () => {
  it('is the earliest boughtAt', () => {
    expect(placedAtOf(parse(forms.multiLine))).toBe('2026-10-01T08:58:30.000Z')
  })

  it('compares instants, not text', () => {
    const lines = [
      { ...base.lineItems[0]!, boughtAt: '2026-10-01T10:30:00+02:00' },
      { ...base.lineItems[0]!, id: '62ae358b-c4e8-11f1-9c77-bedf604a2e99', boughtAt: '2026-10-01T09:00:00Z' },
    ]
    expect(placedAtOf(parse(sampleCheckoutForm({ lineItems: lines })))).toBe('2026-10-01T10:30:00+02:00')
  })

  it('falls back to updatedAt, and fails permanently without either', () => {
    const lines = [{ ...base.lineItems[0]!, boughtAt: undefined }]
    expect(placedAtOf(parse(sampleCheckoutForm({ lineItems: lines })))).toBe('2026-10-01T09:10:05.000Z')
    expect(() => placedAtOf(parse(sampleCheckoutForm({ lineItems: lines, updatedAt: undefined })))).toThrow(PermanentError)
  })
})

describe('factsOf', () => {
  it.each(['READY_FOR_PICKUP', 'SUSPENDED', 'RETURNED', 'PROCESSING', 'READY_FOR_SHIPMENT', 'SOMETHING_NEW'])(
    'adds nothing for the fulfillment status %s',
    (status) => {
      const facts = factsOf(parse(sampleCheckoutForm({ fulfillment: { status } })))
      expect(facts.map((fact) => fact.type)).toEqual(['paid'])
    },
  )

  it('adds paid for a prepaid READY_FOR_PROCESSING form without finishedAt, at updatedAt', () => {
    const form = parse(sampleCheckoutForm({ payment: { type: 'ONLINE' }, updatedAt: '2026-10-01T09:20:00.000Z' }))
    expect(factsOf(form)).toEqual([{ id: `${form.id}:paid`, type: 'paid', occurredAt: '2026-10-01T09:20:00.000Z', note: null }])
    expect(mapOrder(form).awaitingPayment).toBe(false)
    // Not before it is ready, and never for cash on delivery.
    expect(factsOf(parse(sampleCheckoutForm({ status: 'FILLED_IN', payment: { type: 'ONLINE' } })))).toEqual([])
    expect(factsOf(parse(sampleCheckoutForm({ payment: { type: 'CASH_ON_DELIVERY' } })))).toEqual([])
  })

  it('adds shipped for PICKED_UP', () => {
    const facts = factsOf(parse(sampleCheckoutForm({ fulfillment: { status: 'PICKED_UP' } })))
    expect(facts.map((fact) => fact.type)).toEqual(['paid', 'shipped'])
  })

  it('adds one cancelled fact when both the form and its fulfillment are cancelled', () => {
    const facts = factsOf(parse(sampleCheckoutForm({ status: 'CANCELLED', fulfillment: { status: 'CANCELLED' } })))
    expect(facts.filter((fact) => fact.type === 'cancelled')).toHaveLength(1)
  })

  it('orders facts by time, oldest first', () => {
    const facts = factsOf(
      parse(sampleCheckoutForm({ fulfillment: { status: 'SENT' }, updatedAt: '2026-10-01T09:05:00.000Z' })),
    )
    expect(facts.map((fact) => fact.type)).toEqual(['shipped', 'paid'])
  })

  it('keeps the fact ids stable between pulls', () => {
    const later = parse({ ...forms.sent, updatedAt: '2026-10-05T10:00:00.000Z', revision: 'a1b2c3d4' })
    expect(factsOf(later).map((fact) => fact.id)).toEqual(factsOf(parse(forms.sent)).map((fact) => fact.id))
  })

  it('dates a fact with no updatedAt at the latest time the form knows', () => {
    const facts = factsOf(parse(sampleCheckoutForm({ status: 'CANCELLED', updatedAt: undefined })))
    expect(facts.find((fact) => fact.type === 'cancelled')?.occurredAt).toBe('2026-10-01T09:10:00.000Z')
  })
})

describe('mapOrderUpdate', () => {
  it('sends the facts and the addresses of a paid form', () => {
    const update = mapOrderUpdate(parse(forms.companyInvoice))
    expect(update).toEqual({
      kind: 'update',
      externalId: forms.companyInvoice.id,
      facts: [{ id: `${forms.companyInvoice.id}:paid`, type: 'paid', occurredAt: '2026-10-01T09:10:00.000Z', note: null }],
      shippingAddress: annaAddress,
      billingAddress: expect.objectContaining({ taxId: '1234563218' }),
    })
  })

  it('sends billingAddress null for a paid form without an invoice', () => {
    expect(mapOrderUpdate(parse(forms.paidOnline)).billingAddress).toBeNull()
  })

  it('sends no addresses for a form that is not paid yet, or cancelled', () => {
    for (const form of [forms.filledInUnpaid, forms.boughtNoAddress, forms.cancelledAfterPayment]) {
      const update = mapOrderUpdate(parse(form))
      expect(update).not.toHaveProperty('shippingAddress')
      expect(update).not.toHaveProperty('billingAddress')
    }
  })

  it('carries the facts of a shipped form', () => {
    expect(mapOrderUpdate(parse(forms.sent)).facts.map((fact) => fact.type)).toEqual(['paid', 'shipped'])
  })
})

describe('removedOrderUpdate', () => {
  it('is a cancelled fact for a form Allegro merged away', () => {
    expect(removedOrderUpdate('29738e61-c4e8-11f1-89db-60ede9d61a20', '2026-10-05T10:00:00.000Z')).toEqual({
      kind: 'update',
      externalId: '29738e61-c4e8-11f1-89db-60ede9d61a20',
      facts: [
        {
          id: '29738e61-c4e8-11f1-89db-60ede9d61a20:removed',
          type: 'cancelled',
          occurredAt: '2026-10-05T10:00:00.000Z',
          note: 'Merged into another order on the Channel',
        },
      ],
    })
  })

  it('fails permanently for a time that is not ISO 8601', () => {
    expect(() => removedOrderUpdate('29738e61', 'now')).toThrow(PermanentError)
  })
})

describe('hasUsableAddress', () => {
  it.each([
    ['a delivery address', forms.filledInUnpaid, true],
    ['only the account address', forms.boughtAccountAddress, true],
    ['neither', forms.boughtNoAddress, false],
  ])('is right for a form with %s', (_label, form, expected) => {
    expect(hasUsableAddress(parse(form))).toBe(expected)
  })

  it('refuses an incomplete address', () => {
    const payload = sampleCheckoutForm({
      buyer: { ...base.buyer, address: { street: 'Półwiejska 12/4', city: 'Poznań', postCode: '', countryCode: 'PL' } },
      delivery: { address: { ...forms.paidOnline.delivery!.address!, street: '  ' } },
    })
    expect(hasUsableAddress(parse(payload))).toBe(false)
  })
})

describe('isOneFulfillment', () => {
  it('is true only for Orders Allegro fulfils', () => {
    expect(isOneFulfillment(parse(forms.oneFulfillment))).toBe(true)
    expect(isOneFulfillment(parse(forms.paidOnline))).toBe(false)
    expect(isOneFulfillment(parse(sampleCheckoutForm({ fulfillment: null })))).toBe(false)
  })
})
