import { describe, expect, it } from 'vitest'
import { orderSchema as medusaOrderSchema } from '../api'
import { raw, rawAddress, rawItem, rawOrder, rawPayment } from '../testing/samples'
import { mapAddress, mapOrder, mapOrderUpdate, unitPriceAmount } from './order'
import { isOpen, orderFacts, type OrderRules } from './status'

const rules: OrderRules = { pay_on_delivery_provider_ids: ['pp_cod'], paid_when: 'captured' }
const order = (overrides: Record<string, unknown> = {}) => medusaOrderSchema.parse(rawOrder('order_01A', overrides))
const full = (overrides: Record<string, unknown> = {}, with_ = rules) => {
  const mapped = mapOrder(order(overrides), with_)
  if (!mapped.fits) throw new Error(`does not fit: ${mapped.problems.join(', ')}`)
  return mapped.order
}

describe('mapOrder', () => {
  it('maps a captured order with its paid fact, addresses, Buyer, lines and delivery', () => {
    expect(full()).toEqual({
      externalId: 'order_01A',
      placedAt: '2026-10-11T10:00:00.000Z',
      payment: 'prepaid',
      total: { amount: '114.98', currency: 'PLN' },
      buyer: { name: 'Anna Nowak', email: 'anna.nowak@example.com', phone: '+48 600 100 200', login: null },
      shippingAddress: {
        name: 'Anna Nowak',
        company: null,
        street: 'ul. Przykładowa 1, m. 2',
        postalCode: '30-001',
        city: 'Kraków',
        countryCode: 'PL',
        phone: '+48 600 100 200',
        taxId: null,
      },
      billingAddress: {
        name: 'Anna Nowak',
        company: null,
        street: 'ul. Przykładowa 1, m. 2',
        postalCode: '30-001',
        city: 'Kraków',
        countryCode: 'PL',
        phone: '+48 600 100 200',
        taxId: null,
      },
      delivery: { method: 'Standard shipping', pickupPoint: null },
      lines: [
        { externalId: 'order_01A_item_1', offerExternalId: 'variant_01MUG', sku: 'MUG-1', name: 'Mug', quantity: 2, unitPrice: { amount: '49.99', currency: 'PLN' } },
      ],
      facts: [{ id: 'order_01A:paid', type: 'paid', occurredAt: '2026-10-11T10:05:00.000Z', note: null }],
    })
  })

  it.each([['not_paid'], ['awaiting'], ['authorized'], ['requires_action'], ['partially_captured']])('reports payment status %s as awaiting payment, without a paid fact', (paymentStatus) => {
    const mapped = full({ payment_status: paymentStatus })
    expect(mapped.awaitingPayment).toBe(true)
    expect(mapped.facts).toEqual([])
  })

  it.each([['captured'], ['partially_refunded'], ['refunded']])('reports payment status %s as paid', (paymentStatus) => {
    const mapped = full({ payment_status: paymentStatus })
    expect(mapped.awaitingPayment).toBeUndefined()
    expect(mapped.facts.map((fact) => fact.id)).toEqual(['order_01A:paid'])
  })

  it('counts an authorized payment as paid when the plugin says paid_when = authorized, at updated_at without a capture', () => {
    const mapped = full(
      { payment_status: 'authorized', payment_collections: [{ payments: [rawPayment('pay_1')] }] },
      { ...rules, paid_when: 'authorized' },
    )
    expect(mapped.facts).toEqual([{ id: 'order_01A:paid', type: 'paid', occurredAt: '2026-10-11T10:05:00.000Z', note: null }])
  })

  it('reports a payment through a pay-on-delivery provider as cash on delivery: never awaiting payment, no paid fact', () => {
    const cod = { payment_collections: [{ payments: [rawPayment('pay_1', { provider_id: 'pp_cod' })] }] }
    for (const paymentStatus of ['authorized', 'captured', 'not_paid']) {
      const mapped = full({ ...cod, payment_status: paymentStatus })
      expect(mapped).toMatchObject({ payment: 'cash_on_delivery', facts: [] })
      expect(mapped.awaitingPayment).toBeUndefined()
    }
  })

  it('reports shipped and delivered as a shipped fact at the latest live fulfillment, and partially shipped as open', () => {
    const fulfillments = [
      { id: 'ful_1', shipped_at: '2026-10-12T08:00:00.000Z', canceled_at: null },
      { id: 'ful_2', shipped_at: '2026-10-12T09:00:00.000Z', canceled_at: null },
      { id: 'ful_3', shipped_at: '2026-10-13T09:00:00.000Z', canceled_at: '2026-10-13T10:00:00.000Z' },
    ]
    for (const fulfillmentStatus of ['shipped', 'delivered']) {
      const o = order({ fulfillment_status: fulfillmentStatus, fulfillments })
      expect(orderFacts(o, rules).at(-1)).toEqual({ id: 'order_01A:shipped', type: 'shipped', occurredAt: '2026-10-12T09:00:00.000Z', note: null })
      expect(isOpen(o, rules)).toBe(false)
    }
    for (const fulfillmentStatus of ['partially_shipped', 'fulfilled', 'partially_fulfilled', 'partially_delivered']) {
      expect(isOpen(order({ fulfillment_status: fulfillmentStatus, fulfillments }), rules)).toBe(true)
    }
  })

  it('reports a cancelled order with a cancelled fact at canceled_at, after its paid fact', () => {
    const o = order({ status: 'canceled', canceled_at: '2026-10-11T12:00:00.000Z', payment_status: 'refunded' })
    expect(orderFacts(o, rules).map((fact) => [fact.id, fact.occurredAt])).toEqual([
      ['order_01A:paid', '2026-10-11T10:05:00.000Z'],
      ['order_01A:cancelled', '2026-10-11T12:00:00.000Z'],
    ])
    expect(isOpen(o, rules)).toBe(false)
  })

  it('takes amounts from the raw twins, else from the numbers written out exactly', () => {
    const mapped = full({
      total: 1,
      raw_total: raw('207.97'),
      items: [rawItem('i1', { quantity: 3, raw_quantity: raw('3'), total: 100, raw_total: raw('100.00') }), rawItem('i2', { quantity: 3, raw_quantity: null, total: 149.97, raw_total: null })],
    })
    expect(mapped.total.amount).toBe('207.97')
    expect(mapped.lines.map((line) => line.unitPrice.amount)).toEqual(['33.3333', '49.99'])
  })

  it('divides a line total exactly and rounds half-up to 4 places', () => {
    expect(unitPriceAmount({ raw_total: raw('100'), total: 100 }, 3)).toBe('33.3333')
    expect(unitPriceAmount({ raw_total: raw('0.00005'), total: 0 }, 1)).toBe('0.0001')
    expect(unitPriceAmount({ raw_total: raw('2'), total: 2 }, 3)).toBe('0.6667')
  })

  it('upper-cases the currency and the country, uses the company when there is no name, and the customer phone as fallback', () => {
    const mapped = full({ currency_code: 'eur', shipping_address: rawAddress({ first_name: null, last_name: '', company: 'ACME', phone: null, country_code: 'de' }) })
    expect(mapped.total.currency).toBe('EUR')
    expect(mapped.lines[0]!.unitPrice.currency).toBe('EUR')
    expect(mapped.shippingAddress).toMatchObject({ name: 'ACME', company: 'ACME', countryCode: 'DE', phone: '+48 600 300 400' })
    expect(mapped.buyer).toMatchObject({ name: 'ACME', phone: '+48 600 300 400' })
  })

  it('reports an incomplete billing address as none, a line without variant or SKU as unlinked, and no shipping method as no method', () => {
    const mapped = full({
      billing_address: rawAddress({ city: null }),
      items: [rawItem('i1', { variant_id: null, variant_sku: '' })],
      shipping_methods: [],
    })
    expect(mapped.billingAddress).toBeNull()
    expect(mapped.lines[0]).toMatchObject({ offerExternalId: null, sku: null })
    expect(mapped.delivery).toEqual({ method: null, pickupPoint: null })
  })

  it.each([
    [{ items: [] }, ['lines']],
    [{ items: [rawItem('i1', { quantity: 1.5, raw_quantity: raw('1.5') })] }, ['lines.0.quantity', 'lines.0.unitPrice.amount']],
    [{ shipping_address: null }, ['shippingAddress']],
    [{ shipping_address: rawAddress({ postal_code: '' }) }, ['shippingAddress']],
    [{ raw_total: raw('-1') }, ['total.amount']],
    [{ items: [rawItem('i1', { quantity: 3_000_000_000, raw_quantity: raw('3000000000') })] }, ['lines.0.quantity']],
  ])('reports an order that does not fit by field paths: %j', (overrides, problems) => {
    expect(mapOrder(order(overrides), rules)).toEqual({ fits: false, externalId: 'order_01A', problems })
  })
})

describe('mapOrderUpdate', () => {
  it('carries the facts and the addresses', () => {
    const update = mapOrderUpdate(order({ status: 'canceled', canceled_at: '2026-10-11T12:00:00.000Z', billing_address: null }), rules)
    expect(update).toMatchObject({ kind: 'update', externalId: 'order_01A', billingAddress: null, shippingAddress: { name: 'Anna Nowak' } })
    expect(update.facts.map((fact) => fact.type)).toEqual(['paid', 'cancelled'])
  })

  it('leaves out a shipping address that does not fit', () => {
    expect(mapOrderUpdate(order({ shipping_address: null }), rules)).not.toHaveProperty('shippingAddress')
  })
})

describe('mapAddress', () => {
  it('is null for no address', () => {
    expect(mapAddress(null)).toBeNull()
    expect(mapAddress(undefined)).toBeNull()
  })
})
