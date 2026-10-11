// Test tooling only: never imported by the connector itself.
import { FakeMedusa } from './fake-medusa'
import { raw, rawAddress, rawItem, rawPayment } from './samples'

/**
 * The store the provisional conformance cassettes were made from (`MEDUSA_RECORDING_SOURCE=fake`), shaped like the
 * sandbox's seed (`sandbox/app/src/scripts/seed.ts`): variants of six products, and five orders placed before the
 * journal's position. Replaced by a recording from the sandbox once the plugin exists (AGENTS.md).
 */
export function conformanceStore(): FakeMedusa {
  const store = new FakeMedusa('2026-10-11T09:00:00.000Z')
  store.prunedThroughSeq = 2
  store.startJournalAt(3)
  store
    .variant('variant_01JA0001', { sku: 'MUG-1', product: { title: 'Mug', status: 'published' } })
    .variant('variant_01JA0002', {
      sku: 'TSHIRT-S',
      title: 'S',
      product: { title: 'T-shirt', status: 'published' },
      prices: [{ id: 'price_2', currency_code: 'pln', amount: 79, raw_amount: raw('79'), min_quantity: null, max_quantity: null, rules: {} }],
    })
    .variant('variant_01JA0003', {
      sku: 'TSHIRT-M',
      title: 'M',
      product: { title: 'T-shirt', status: 'published' },
      prices: [
        { id: 'price_3a', currency_code: 'pln', amount: 75, min_quantity: null, max_quantity: null, rules: { region_id: 'reg_01PL' } },
        { id: 'price_3b', currency_code: 'pln', amount: 79, min_quantity: null, max_quantity: null, rules: {} },
      ],
    })
    .variant('variant_01JA0004', { sku: 'GIFT-50', manage_inventory: false, product: { title: 'Gift card', status: 'published' } })
    .variant('variant_01JA0005', { sku: 'SOON-1', product: { title: 'Coming soon', status: 'draft' } })
    .variant('variant_01JA0006', { sku: null, product: { title: 'Poster', status: 'published' }, prices: [] })

  store.place({ id: 'order_01JA0001', display_id: 1 })
  store.tick(60)
  store.placeUnpaid({ id: 'order_01JA0002', display_id: 2, items: [rawItem('item_01JA0002', { variant_id: 'variant_01JA0002', variant_sku: 'TSHIRT-S', title: 'T-shirt', variant_title: 'S', quantity: 1, raw_quantity: raw('1'), total: 79 })] })
  store.tick(60)
  const shipped = store.place({ id: 'order_01JA0003', display_id: 3 })
  store.tick(60)
  store.shipAll(shipped)
  store.tick(60)
  const cancelled = store.placeUnpaid({ id: 'order_01JA0004', display_id: 4 })
  store.tick(60)
  store.cancelOrder(cancelled)
  store.tick(60)
  store.place({
    id: 'order_01JA0005',
    display_id: 5,
    total: 207.97,
    items: [
      rawItem('item_01JA0005a'),
      rawItem('item_01JA0005b', { variant_id: 'variant_01JA0003', variant_sku: 'TSHIRT-M', title: 'T-shirt', variant_title: 'M', quantity: 1, raw_quantity: raw('1'), total: 79 }),
    ],
    shipping_address: rawAddress({ first_name: 'Jan', last_name: 'Kowalski', company: 'Kowalski sp. z o.o.', address_2: null }),
    payment_collections: [{ id: 'paycol_5', payments: [rawPayment('pay_5', { amount: 207.97, captured_at: '2026-10-11T09:06:00.000Z', captured_amount: 207.97 })] }],
  })
  store.tick(60)
  return store
}
