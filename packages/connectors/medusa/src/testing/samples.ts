// Test tooling only: never imported by the connector itself.
//
// Medusa objects in the shapes the Admin API answers with (Medusa 2.21.2, read from its route and workflow code and
// its docs; AGENTS.md lists what is still to verify in the sandbox). Computed totals (`total` of an order and of an
// item) come as numbers without a raw twin; stored amounts such as an item's quantity carry one (`raw_quantity`).
// Every person and address is invented.

export type Json = Record<string, unknown>

/** A BigNumber's raw twin, as Medusa sends it next to the JSON number. */
export function raw(value: string): { value: string; precision: number } {
  return { value, precision: 20 }
}

export function rawAddress(overrides: Json = {}): Json {
  return {
    id: 'caaddr_1',
    first_name: 'Anna',
    last_name: 'Nowak',
    company: null,
    address_1: 'ul. Przykładowa 1',
    address_2: 'm. 2',
    city: 'Kraków',
    postal_code: '30-001',
    country_code: 'pl',
    province: null,
    phone: '+48 600 100 200',
    ...overrides,
  }
}

export function rawItem(id: string, overrides: Json = {}): Json {
  return {
    id,
    title: 'Mug',
    product_title: 'Mug',
    variant_title: 'Default variant',
    variant_id: 'variant_01MUG',
    variant_sku: 'MUG-1',
    quantity: 2,
    raw_quantity: raw('2'),
    unit_price: 49.99,
    raw_unit_price: raw('49.99'),
    total: 99.98,
    ...overrides,
  }
}

export function rawPayment(id: string, overrides: Json = {}): Json {
  return {
    id,
    provider_id: 'pp_system_default',
    amount: 114.98,
    captured_at: null,
    canceled_at: null,
    captured_amount: 0,
    ...overrides,
  }
}

/** An order placed in the store: one line, paid online and captured, not fulfilled. */
export function rawOrder(id: string, overrides: Json = {}): Json {
  return {
    id,
    display_id: 1,
    status: 'pending',
    created_at: '2026-10-11T10:00:00.000Z',
    updated_at: '2026-10-11T10:05:00.000Z',
    canceled_at: null,
    email: 'anna.nowak@example.com',
    currency_code: 'pln',
    total: 114.98,
    sales_channel_id: 'sc_01WEB',
    is_draft_order: false,
    payment_status: 'captured',
    fulfillment_status: 'not_fulfilled',
    items: [rawItem(`${id}_item_1`)],
    shipping_address: rawAddress(),
    billing_address: rawAddress({ id: 'caaddr_2' }),
    fulfillments: [],
    payment_collections: [{ id: `paycol_${id}`, payments: [rawPayment(`pay_${id}`, { captured_at: '2026-10-11T10:05:00.000Z', captured_amount: 114.98 })] }],
    shipping_methods: [{ name: 'Standard shipping' }],
    customer: { phone: '+48 600 300 400' },
    ...overrides,
  }
}

/** A variant with its product and one plain price. */
export function rawVariant(id: string, overrides: Json = {}): Json {
  return {
    id,
    sku: `SKU-${id.slice(-3)}`,
    title: 'Default variant',
    manage_inventory: true,
    product_id: `prod_${id.slice(-3)}`,
    product: { title: 'Mug', status: 'published' },
    prices: [{ id: `price_${id}`, currency_code: 'pln', amount: 49.99, min_quantity: null, max_quantity: null, rules: {} }],
    ...overrides,
  }
}
