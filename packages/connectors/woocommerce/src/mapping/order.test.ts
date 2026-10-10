import { orderSchema, orderUpdateSchema } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { wooOrderSchema, type WooOrder } from '../api'
import { EMPTY_ADDRESS, rawLine, rawOrder } from '../testing/samples'
import { isAwaitingPayment, isEmptyAddress, isOpen, mapAddress, mapOrder, mapOrderUpdate, orderFacts, unitPriceAmount } from './order'

// The base is the sandbox's order 39 (prepaid, paid, `processing`). Each test changes the fields its row of the
// spec's table is about, to the values the sandbox sent for such an order.
const order = (overrides: Record<string, unknown> = {}): WooOrder => wooOrderSchema.parse(rawOrder(overrides))

const MODIFIED = '2026-10-10T19:01:48Z'
const unpaid = { date_paid: null, date_paid_gmt: null }

function mapped(overrides: Record<string, unknown> = {}) {
  const result = mapOrder(order(overrides))
  if (!result.fits) throw new Error(`does not fit: ${result.problems.join(', ')}`)
  return result.order
}

function problems(overrides: Record<string, unknown>) {
  const result = mapOrder(order(overrides))
  if (result.fits) throw new Error('fits')
  return result.problems
}

describe('mapOrder', () => {
  it('maps a paid order with several lines, a company and another recipient', () => {
    expect(mapped()).toEqual({
      externalId: '39',
      placedAt: '2026-09-21T07:20:00Z',
      payment: 'prepaid',
      total: { amount: '426.96', currency: 'PLN' },
      buyer: { name: 'Ewa Fikcyjna', email: 'ewa.fikcyjna@example.test', phone: '+48 000 000 104', login: null },
      shippingAddress: {
        name: 'Marek Odbiorca',
        company: 'Fikcyjna Firma Sp. z o.o. Magazyn',
        street: 'ul. Magazynowa 5',
        postalCode: '90-001',
        city: 'Łódź',
        countryCode: 'PL',
        phone: '+48 000 000 106',
        taxId: null,
      },
      billingAddress: {
        name: 'Ewa Fikcyjna',
        company: 'Fikcyjna Firma Sp. z o.o.',
        street: 'ul. Wymyślona 22',
        postalCode: '50-001',
        city: 'Wrocław',
        countryCode: 'PL',
        phone: '+48 000 000 104',
        taxId: null,
      },
      lines: [
        // (126.13 + 29.01) / 2: the float `price` of this line is 63.065041, without tax.
        { externalId: '26', offerExternalId: '19:20', sku: 'WOO-TSHIRT-S', name: 'Koszulka testowa - S', quantity: 2, unitPrice: { amount: '77.57', currency: 'PLN' } },
        // A variation without a SKU of its own: the line carries its parent's.
        { externalId: '27', offerExternalId: '19:21', sku: 'WOO-TSHIRT', name: 'Koszulka testowa - M', quantity: 1, unitPrice: { amount: '77.57', currency: 'PLN' } },
        // (118.44 + 27.24) / 3, after the coupon's share.
        { externalId: '28', offerExternalId: '10', sku: 'WOO-MUG-1', name: 'Kubek ceramiczny żółty', quantity: 3, unitPrice: { amount: '48.56', currency: 'PLN' } },
        { externalId: '29', offerExternalId: '12', sku: null, name: 'Plakat bez SKU', quantity: 1, unitPrice: { amount: '33.58', currency: 'PLN' } },
      ],
      facts: [{ id: '39:paid', type: 'paid', occurredAt: '2026-09-21T07:22:00Z', note: null }],
    })
  })

  it('returns what orderSchema accepts, and the same for the same snapshot', () => {
    expect(orderSchema.parse(mapped())).toEqual(mapped())
  })

  it('reads the times as UTC, from the _gmt fields, not from the site-time ones beside them', () => {
    // Warsaw is two hours ahead here: `date_created` says 09:20, `date_created_gmt` 07:20.
    expect(rawOrder().date_created).toBe('2026-09-21T09:20:00')
    expect(mapped().placedAt).toBe('2026-09-21T07:20:00Z')
  })

  describe('payment', () => {
    it('cash on delivery is never awaiting payment and never gets a paid fact', () => {
      const cod = mapped({ payment_method: 'cod', ...unpaid })
      expect(cod.payment).toBe('cash_on_delivery')
      expect(cod).not.toHaveProperty('awaitingPayment')
      expect(cod.facts).toEqual([])
    })

    it('cash on delivery stays without a paid fact when WooCommerce stamps date_paid at completion', () => {
      const completed = mapped({ payment_method: 'cod', status: 'completed', date_paid_gmt: '2026-10-10T19:01:49', date_completed_gmt: '2026-10-10T19:01:49' })
      expect(completed.payment).toBe('cash_on_delivery')
      expect(completed.facts).toEqual([{ id: '39:shipped', type: 'shipped', occurredAt: '2026-10-10T19:01:49Z', note: null }])
    })

    it.each(['przelewy24', 'bacs', 'cheque', 'stripe', 'a-plugins-gateway', ''])('method %j is prepaid', (payment_method) => {
      expect(mapped({ payment_method }).payment).toBe('prepaid')
    })

    it('a paid fact at date_paid_gmt once the payment is recorded', () => {
      expect(mapped().facts).toEqual([{ id: '39:paid', type: 'paid', occurredAt: '2026-09-21T07:22:00Z', note: null }])
      expect(mapped()).not.toHaveProperty('awaitingPayment')
    })

    it.each(['processing', 'completed'])('a prepaid %s order without a payment date is paid at its last change', (status) => {
      const facts = mapped({ status, ...unpaid }).facts
      expect(facts[0]).toEqual({ id: '39:paid', type: 'paid', occurredAt: MODIFIED, note: null })
      expect(mapped({ status, ...unpaid })).not.toHaveProperty('awaitingPayment')
    })

    it.each([
      ['pending', 'przelewy24'],
      ['on-hold', 'bacs'],
      ['on-hold', 'cheque'],
      ['packing', 'przelewy24'],
    ])('a prepaid %s order (%s) nobody paid for is awaiting payment', (status, payment_method) => {
      const awaiting = mapped({ status, payment_method, ...unpaid })
      expect(awaiting.awaitingPayment).toBe(true)
      expect(awaiting.facts).toEqual([])
    })

    it.each(['on-hold', 'pending', 'packing'])('an order moved to %s after its payment keeps the paid fact and is not awaiting payment', (status) => {
      const order = mapped({ status })
      expect(order).not.toHaveProperty('awaitingPayment')
      expect(order.facts).toEqual([{ id: '39:paid', type: 'paid', occurredAt: '2026-09-21T07:22:00Z', note: null }])
    })
  })

  describe('shipped and cancelled', () => {
    it('completed is a shipped fact at date_completed_gmt', () => {
      expect(mapped({ status: 'completed', date_completed_gmt: '2026-10-10T19:01:47' }).facts).toEqual([
        { id: '39:paid', type: 'paid', occurredAt: '2026-09-21T07:22:00Z', note: null },
        { id: '39:shipped', type: 'shipped', occurredAt: '2026-10-10T19:01:47Z', note: null },
      ])
    })

    it('completed without a completion date is shipped at its last change', () => {
      expect(mapped({ status: 'completed' }).facts.at(-1)).toEqual({ id: '39:shipped', type: 'shipped', occurredAt: MODIFIED, note: null })
    })

    it('an order moved on from completed was still shipped: date_completed_gmt outlives the status', () => {
      // The sandbox, after completed → processing: the status is back, the date stays.
      expect(mapped({ status: 'processing', date_completed_gmt: '2026-10-10T18:46:28' }).facts.map((fact) => fact.id)).toEqual(['39:paid', '39:shipped'])
    })

    it.each(['cancelled', 'refunded', 'failed', 'trash'])('%s is a cancelled fact at the last change, naming the status', (status) => {
      expect(mapped({ status }).facts.at(-1)).toEqual({ id: '39:cancelled', type: 'cancelled', occurredAt: MODIFIED, note: `WooCommerce status: ${status}` })
    })

    it('a cancelled order nobody paid for is still marked awaiting payment (an abandoned checkout)', () => {
      const abandoned = mapped({ status: 'cancelled', ...unpaid })
      expect(abandoned.awaitingPayment).toBe(true)
      expect(abandoned.facts.map((fact) => fact.type)).toEqual(['cancelled'])
    })

    it('lists the facts oldest first: completed, then refunded', () => {
      const refunded = mapped({ status: 'refunded', date_completed_gmt: '2026-10-10T18:46:25', date_modified_gmt: '2026-10-10T18:51:39' })
      expect(refunded.facts.map((fact) => [fact.id, fact.occurredAt])).toEqual([
        ['39:paid', '2026-09-21T07:22:00Z'],
        ['39:shipped', '2026-10-10T18:46:25Z'],
        ['39:cancelled', '2026-10-10T18:51:39Z'],
      ])
    })

    it('keeps the order paid, shipped, cancelled for facts of the same second', () => {
      const facts = mapped({ status: 'refunded', date_paid_gmt: '2026-10-10T19:01:48', date_completed_gmt: '2026-10-10T19:01:48' }).facts
      expect(facts.map((fact) => fact.type)).toEqual(['paid', 'shipped', 'cancelled'])
    })

    it('a failed order paid later has only the paid fact left in its snapshot', () => {
      expect(mapped({ status: 'processing', date_paid_gmt: '2026-10-10T18:52:59' }).facts.map((fact) => fact.type)).toEqual(['paid'])
    })

    it('gives every fact the same id on every pull, whatever changed meanwhile', () => {
      const before = mapped({ status: 'completed', date_completed_gmt: '2026-10-10T18:46:28' }).facts.map((fact) => fact.id)
      const after = mapped({ status: 'completed', date_completed_gmt: '2026-10-10T18:51:43', date_modified_gmt: '2026-10-10T18:51:43' }).facts.map((fact) => fact.id)
      expect(after).toEqual(before)
    })
  })

  describe('addresses', () => {
    it('ships to the billing address when the shipping address is empty (virtual goods)', () => {
      const virtual = mapped({ shipping: EMPTY_ADDRESS })
      expect(virtual.shippingAddress).toEqual(virtual.billingAddress)
      expect(virtual.shippingAddress.name).toBe('Ewa Fikcyjna')
    })

    it('has no billing address when the billing one is incomplete, and still ships to the shipping one', () => {
      const guest = mapped({ billing: { ...EMPTY_ADDRESS, first_name: 'Ewa', last_name: 'Fikcyjna', email: 'ewa.fikcyjna@example.test' } })
      expect(guest.billingAddress).toBeNull()
      expect(guest.shippingAddress.name).toBe('Marek Odbiorca')
      expect(guest.buyer).toEqual({ name: 'Ewa Fikcyjna', email: 'ewa.fikcyjna@example.test', phone: null, login: null })
    })

    it('joins the two street lines and drops the state, which the canonical address has no place for', () => {
      const address = mapped({ shipping: { ...EMPTY_ADDRESS, first_name: 'Hans', last_name: 'Beispiel', address_1: 'Musterstraße 1', address_2: 'Hinterhaus', city: 'Berlin', state: 'DE-BE', postcode: '10115', country: 'DE' } }).shippingAddress
      expect(address).toEqual({ name: 'Hans Beispiel', company: null, street: 'Musterstraße 1, Hinterhaus', postalCode: '10115', city: 'Berlin', countryCode: 'DE', phone: null, taxId: null })
    })

    it('names an address after its company when it has no person', () => {
      const address = mapped({ shipping: { ...EMPTY_ADDRESS, company: 'Fikcyjna Firma Sp. z o.o.', address_1: 'ul. Magazynowa 5', city: 'Łódź', postcode: '90-001', country: 'PL' } }).shippingAddress
      expect(address).toMatchObject({ name: 'Fikcyjna Firma Sp. z o.o.', company: 'Fikcyjna Firma Sp. z o.o.' })
    })

    it('names the Buyer after the recipient when the order has no billing data at all', () => {
      expect(mapped({ billing: { ...EMPTY_ADDRESS, email: '' } }).buyer).toEqual({ name: 'Marek Odbiorca', email: null, phone: null, login: null })
    })

    it('reads a null where WooCommerce sends an empty string the same way', () => {
      const shipping = Object.fromEntries(Object.keys(EMPTY_ADDRESS).map((key) => [key, null]))
      expect(mapped({ shipping }).shippingAddress.name).toBe('Ewa Fikcyjna')
    })
  })

  describe('lines', () => {
    it('has no Offer for a line whose product was deleted', () => {
      // As the sandbox sent it: product_id 0, sku null.
      const deleted = rawLine(0, { name: 'Produkt wycofany', product_id: 0, variation_id: 0, quantity: 1, total: '12.20', total_tax: '2.80', sku: null, global_unique_id: null, parent_name: null })
      expect(mapped({ line_items: [deleted] }).lines).toEqual([
        { externalId: '26', offerExternalId: null, sku: null, name: 'Produkt wycofany', quantity: 1, unitPrice: { amount: '15.00', currency: 'PLN' } },
      ])
    })

    it('rounds a unit price that does not divide evenly half-up to four places', () => {
      expect(mapped({ line_items: [rawLine(2, { quantity: 3, total: '100.00', total_tax: '0.00' })] }).lines[0]!.unitPrice).toEqual({ amount: '33.3333', currency: 'PLN' })
      expect(mapped({ line_items: [rawLine(2, { quantity: 3, total: '162.60', total_tax: '37.40' })] }).lines[0]!.unitPrice).toEqual({ amount: '66.6667', currency: 'PLN' })
    })

    it('prices a line without tax (a Buyer abroad) and a free one', () => {
      expect(mapped({ line_items: [rawLine(0, { quantity: 1, total: '129.27', total_tax: '0.00' })] }).lines[0]!.unitPrice.amount).toBe('129.27')
      expect(mapped({ line_items: [rawLine(0, { quantity: 2, total: '0.00', total_tax: '0.00' })] }).lines[0]!.unitPrice.amount).toBe('0.00')
    })

    it('gives every line the currency of the order', () => {
      const euro = mapped({ currency: 'EUR' })
      expect(euro.total.currency).toBe('EUR')
      expect(new Set(euro.lines.map((line) => line.unitPrice.currency))).toEqual(new Set(['EUR']))
    })
  })

  describe('what goes into a fact\'s note', () => {
    it('is one of four fixed texts, never a status the shop made up', () => {
      const odd = ['<script>alert(1)</script>', 'x'.repeat(64), 'cancelled ', 'CANCELLED', 'wc-cancelled', 'trash\n', 'refunded; drop', 'packing']
      const notes = [...odd, 'cancelled', 'refunded', 'failed', 'trash', 'completed', 'processing']
        .flatMap((status) => orderFacts(order({ status })))
        .map((fact) => fact.note)
        .filter((note) => note !== null)
      expect([...new Set(notes)].sort()).toEqual(['WooCommerce status: cancelled', 'WooCommerce status: failed', 'WooCommerce status: refunded', 'WooCommerce status: trash'])
    })
  })

  describe('an order whose payment or completion date cannot be read', () => {
    // The reader turns such a date into null (`api.ts`); these are the snapshots that leaves.
    it('is shipped and paid by its status alone, at the time of its last change', () => {
      expect(orderFacts(order({ status: 'completed', date_paid_gmt: '-0001-11-30T00:00:00', date_completed_gmt: '' }))).toEqual([
        { id: '39:paid', type: 'paid', occurredAt: MODIFIED, note: null },
        { id: '39:shipped', type: 'shipped', occurredAt: MODIFIED, note: null },
      ])
    })

    it('is not shipped by a date that says "never": an old shop\'s open orders stay open', () => {
      const old = order({ status: 'on-hold', date_paid_gmt: '-0001-11-30T00:00:00', date_completed_gmt: '-0001-11-30T00:00:00' })
      expect(orderFacts(old)).toEqual([])
      expect(isOpen(old)).toBe(true)
      expect(isAwaitingPayment(old)).toBe(true)
    })
  })

  describe('an order the canonical model cannot hold', () => {
    it.each([
      ['no lines', { line_items: [] }, ['lines']],
      ['no address at all', { billing: { ...EMPTY_ADDRESS, email: '' }, shipping: EMPTY_ADDRESS }, ['buyer.name', 'shippingAddress']],
      ['a shipping address that is filled in but incomplete', { shipping: { ...EMPTY_ADDRESS, first_name: 'Marek', last_name: 'Odbiorca', city: 'Łódź' } }, ['shippingAddress']],
      ['a shipping address without a country', { shipping: { ...(rawOrder().shipping as object), country: '' } }, ['shippingAddress']],
      ['a fractional quantity', { line_items: [rawLine(0, { quantity: 1.5 })] }, ['lines.0.quantity', 'lines.0.unitPrice.amount']],
      ['a quantity of zero', { line_items: [rawLine(0, { quantity: 0 })] }, ['lines.0.quantity', 'lines.0.unitPrice.amount']],
      // One above what Hanza's 32-bit column holds; the core would refuse the whole page for it.
      ['a quantity Hanza cannot store', { line_items: [rawLine(0, { quantity: 2_147_483_648 })] }, ['lines.0.quantity']],
      ['a negative line total', { line_items: [rawLine(0, { total: '-10.00' })] }, ['lines.0.unitPrice.amount']],
      ['a line without a name', { line_items: [rawLine(0, { name: '' })] }, ['lines.0.name']],
      ['a negative total', { total: '-73.99' }, ['total.amount']],
      ['a total that is not a number', { total: '' }, ['total.amount']],
      ['a total longer than an amount is', { total: '9'.repeat(41) }, ['total.amount']],
      ['a line total longer than an amount is', { line_items: [rawLine(0, { total: '9'.repeat(41) })] }, ['lines.0.unitPrice.amount']],
      ['more lines than an order has', { line_items: Array.from({ length: 1001 }, (_, index) => rawLine(0, { id: index + 1 })) }, ['lines']],
      ['a currency longer than a currency is', { currency: 'P'.repeat(300) }, ['total.currency', 'lines.0.unitPrice.currency', 'lines.1.unitPrice.currency', 'lines.2.unitPrice.currency', 'lines.3.unitPrice.currency']],
      ['no currency', { currency: '' }, ['total.currency', 'lines.0.unitPrice.currency', 'lines.1.unitPrice.currency', 'lines.2.unitPrice.currency', 'lines.3.unitPrice.currency']],
    ])('reports %s as paths, without throwing', (_, overrides, expected) => {
      expect(problems(overrides).sort()).toEqual([...expected].sort())
    })

    it('takes the largest quantity Hanza can store', () => {
      expect(mapped({ line_items: [rawLine(0, { quantity: 2_147_483_647 })] }).lines[0]!.quantity).toBe(2_147_483_647)
    })

    it('says which order, and nothing of what is in it', () => {
      const result = mapOrder(order({ shipping: { ...EMPTY_ADDRESS, first_name: 'Marek', last_name: 'Odbiorca', city: 'Łódź' }, line_items: [] }))
      expect(result).toEqual({ fits: false, externalId: '39', problems: ['shippingAddress', 'lines'] })
      expect(JSON.stringify(result)).not.toMatch(/Marek|Odbiorca|Łódź|Ewa|example\.test/)
    })

    it('still gives its facts as an Order update', () => {
      const closed = order({ line_items: [], status: 'cancelled', ...unpaid })
      expect(mapOrder(closed).fits).toBe(false)
      expect(mapOrderUpdate(closed)).toEqual({
        kind: 'update',
        externalId: '39',
        facts: [{ id: '39:cancelled', type: 'cancelled', occurredAt: MODIFIED, note: 'WooCommerce status: cancelled' }],
      })
    })
  })
})

describe('mapOrderUpdate', () => {
  it('carries the facts of the snapshot and no addresses', () => {
    const update = mapOrderUpdate(order({ status: 'completed', date_completed_gmt: '2026-10-10T19:01:47' }))
    expect(update).toEqual({
      kind: 'update',
      externalId: '39',
      facts: [
        { id: '39:paid', type: 'paid', occurredAt: '2026-09-21T07:22:00Z', note: null },
        { id: '39:shipped', type: 'shipped', occurredAt: '2026-10-10T19:01:47Z', note: null },
      ],
    })
    expect(orderUpdateSchema.parse(update)).toEqual(update)
  })

  it('has the same facts, with the same ids, as the full Order of the same snapshot', () => {
    const snapshot = order({ status: 'refunded', date_completed_gmt: '2026-10-10T18:46:25' })
    expect(mapOrderUpdate(snapshot).facts).toEqual(orderFacts(snapshot))
    expect(mapped({ status: 'refunded', date_completed_gmt: '2026-10-10T18:46:25' }).facts).toEqual(orderFacts(snapshot))
  })

  it('is an update without facts for an open order', () => {
    expect(mapOrderUpdate(order({ status: 'pending', ...unpaid }))).toEqual({ kind: 'update', externalId: '39', facts: [] })
  })
})

describe('isOpen', () => {
  it.each(['pending', 'on-hold', 'processing', 'packing'])('%s is open', (status) => {
    expect(isOpen(order({ status }))).toBe(true)
  })

  it.each(['completed', 'cancelled', 'refunded', 'failed', 'trash'])('%s is closed', (status) => {
    expect(isOpen(order({ status }))).toBe(false)
  })

  it('an order that was completed once is closed whatever its status says now', () => {
    expect(isOpen(order({ status: 'processing', date_completed_gmt: '2026-10-10T18:46:28' }))).toBe(false)
  })
})

describe('isAwaitingPayment', () => {
  it('follows the paid fact, never the payment method alone', () => {
    expect(isAwaitingPayment(order({ status: 'pending', ...unpaid }))).toBe(true)
    expect(isAwaitingPayment(order({ status: 'pending' }))).toBe(false)
    expect(isAwaitingPayment(order({ status: 'processing', ...unpaid }))).toBe(false)
    expect(isAwaitingPayment(order({ status: 'pending', payment_method: 'cod', ...unpaid }))).toBe(false)
  })
})

describe('the helpers', () => {
  it('unitPriceAmount adds the tax and divides by the quantity', () => {
    expect(unitPriceAmount({ total: '126.13', total_tax: '29.01', quantity: 2 })).toBe('77.57')
    expect(unitPriceAmount({ total: '48.54', total_tax: '11.16', quantity: 3 })).toBe('19.90')
    expect(unitPriceAmount({ total: '126.13', total_tax: '29.01', quantity: 0 })).toBeNull()
    expect(unitPriceAmount({ total: 'x', total_tax: '29.01', quantity: 1 })).toBeNull()
  })

  it('isEmptyAddress ignores the phone and the state', () => {
    const empty = wooOrderSchema.parse(rawOrder({ shipping: { ...EMPTY_ADDRESS, phone: '+48 000 000 106', state: 'DE-BE' } })).shipping
    expect(isEmptyAddress(empty)).toBe(true)
    expect(isEmptyAddress(order().shipping)).toBe(false)
    expect(mapAddress(empty)).toBeNull()
  })
})
