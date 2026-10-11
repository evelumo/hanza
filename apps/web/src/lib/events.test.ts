import { describe, expect, it } from 'vitest'
import { catalogues } from '@/i18n/catalogues'
import { translatorFor } from '@/i18n/testing'
import { createFormatters } from './format'
import { describeEvent, eventRefsToResolve } from './events'

const t = translatorFor('en')
const format = createFormatters('en')
const formatPl = createFormatters('pl')

describe('describeEvent', () => {
  it('describes a status change with the phase names when the Event has no status names', () => {
    expect(describeEvent('order.status_changed', { from: 'new', to: 'shipped' }, t, format)).toEqual({ title: 'Status changed', detail: 'New → Shipped' })
    const { orderPhase } = catalogues.pl.labels
    expect(describeEvent('order.status_changed', { from: 'new', to: 'shipped' }, translatorFor('pl'), formatPl)).toEqual({
      title: catalogues.pl.events.title.order_status_changed,
      detail: `${orderPhase.new} → ${orderPhase.shipped}`,
    })
    expect(orderPhase.new).not.toBe(catalogues.en.labels.orderPhase.new)
  })

  it('describes a status change with the status names the Event kept, a null name being the phase', () => {
    const payload = {
      from: 'processing',
      to: 'processing',
      fromStatus: { id: 'a', name: 'Waiting for packaging' },
      toStatus: { id: 'b', name: 'Packed' },
    }
    expect(describeEvent('order.status_changed', payload, t, format).detail).toBe('Waiting for packaging → Packed')
    const toDefault = { from: 'processing', to: 'shipped', fromStatus: { id: 'b', name: 'Packed' }, toStatus: { id: 'c', name: null } }
    expect(describeEvent('order.status_changed', toDefault, translatorFor('pl'), formatPl).detail).toBe(`Packed → ${catalogues.pl.labels.orderPhase.shipped}`)
    expect(describeEvent('order.status_changed', { from: 'new', to: 'new', toStatus: 'garbage' }, t, format).detail).toBe('New → New')
  })

  it('shows an unnamed status by the phase it kept, in the viewer\'s language', () => {
    const payload = { from: 'processing', to: 'processing', fromStatus: { id: 'a', name: null, phase: 'processing' }, toStatus: { id: 'b', name: 'Packed', phase: 'processing' } }
    expect(describeEvent('order.status_changed', payload, translatorFor('pl'), formatPl).detail).toBe(`${catalogues.pl.labels.orderPhase.processing} → Packed`)
    expect(describeEvent('order.status_changed', payload, t, format).detail).toBe('Processing → Packed')
  })

  it('shows a former default (no name) in a Status mapping change as its phase, and no status as the default', () => {
    const formerDefault = { phase: 'new', from: { id: 'x', name: null, phase: 'new' }, to: { id: 'y', name: 'To check', phase: 'new' } }
    expect(describeEvent('connection.status_mapping_changed', formerDefault, t, format).detail).toBe('New: New → To check')
    expect(describeEvent('connection.status_mapping_changed', { phase: 'new', from: { id: 'y', name: 'To check', phase: 'new' }, to: null }, t, format).detail).toBe(
      'New: To check → default status',
    )
  })

  it('describes a change of a Status mapping', () => {
    const payload = { phase: 'cancelled', from: null, to: { id: 'x', name: 'Refunded' } }
    expect(describeEvent('connection.status_mapping_changed', payload, t, format)).toEqual({
      title: 'Order statuses from the channel changed',
      detail: 'Cancelled: default status → Refunded',
    })
  })

  it('describes stock and health changes', () => {
    expect(describeEvent('stock.set', { from: 3, to: 10 }, t, format).detail).toBe('3 → 10')
    expect(describeEvent('stock.set', { from: null, to: 0 }, t, format).detail).toBe('not set → 0')
    expect(describeEvent('stock.set', { from: 1000, to: 1200 }, t, format).detail).toBe('1,000 → 1,200')
    expect(describeEvent('stock.set', { from: 10000, to: 12500 }, translatorFor('pl'), formatPl)?.detail?.replace(/\s/g, ' ')).toBe('10 000 → 12 500')
    expect(describeEvent('connection.health_changed', { from: 'unknown', to: 'ok' }, t, format).detail).toBe('Not checked → Working')
    expect(describeEvent('connection.signed_in', { connectorId: 'x', account: 'seller-1' }, t, format)).toEqual({
      title: 'Signed in to the channel',
      detail: 'seller-1',
    })
    expect(describeEvent('order.attention_raised', { reasons: ['unmatched_line', 'shortage'] }, t, format).detail).toBe('Unmatched line, Shortage')
  })

  it('describes price changes, a removed price included, and ignores a malformed one', () => {
    const pln = { amount: '45', currency: 'PLN' }
    expect(describeEvent('product.price_changed', { from: null, to: pln }, t, format)).toEqual({ title: 'Base price changed', detail: `No price → ${format.money(pln)}` })
    expect(describeEvent('offer.price_changed', { from: pln, to: null }, translatorFor('pl'), formatPl)).toEqual({
      title: catalogues.pl.events.title.offer_price_changed,
      detail: `${formatPl.money(pln)} → ${catalogues.pl.prices.none}`,
    })
    expect(formatPl.money(pln).replace(/\s/g, ' ')).toBe('45,00 zł')
    expect(describeEvent('offer.price_changed', { from: 45, to: pln }, t, format).detail).toBeNull()
    expect(describeEvent('offer.price_changed', { from: { amount: 45, currency: 'PLN' }, to: pln }, t, format).detail).toBeNull()
  })

  it('describes a payment reported by the Channel', () => {
    expect(describeEvent('order.channel_fact_recorded', { type: 'paid' }, t, format)).toEqual({
      title: 'The channel reported a change',
      detail: 'Paid in the channel',
    })
    expect(describeEvent('order.payment_received', { factId: 'f' }, t, format)).toEqual({ title: 'Payment received', detail: null })
    expect(describeEvent('order.payment_received', {}, translatorFor('pl'), formatPl).title).toBe(catalogues.pl.events.title.order_payment_received)
  })

  it('describes new addresses from the Channel by which one changed, never what it says', () => {
    expect(describeEvent('order.addresses_updated', { shippingAddress: true, billingAddress: false }, t, format)).toEqual({
      title: 'The channel sent new addresses',
      detail: 'shipping address',
    })
    expect(describeEvent('order.addresses_updated', { shippingAddress: false, billingAddress: true }, t, format).detail).toBe('billing address')
    expect(describeEvent('order.addresses_updated', { shippingAddress: true, billingAddress: true }, t, format).detail).toBe('shipping and billing address')
    expect(describeEvent('order.addresses_updated', { shippingAddress: 'yes' }, t, format).detail).toBeNull()
    expect(describeEvent('order.addresses_updated', { shippingAddress: true }, translatorFor('pl'), formatPl).detail).toBe('adres dostawy')
  })

  it('describes a restarted Order feed with the gap it may leave', () => {
    expect(describeEvent('connection.order_feed_restarted', {}, t, format)).toEqual({
      title: 'Order feed restarted',
      detail: 'orders placed and closed meanwhile may be missing',
    })
    expect(describeEvent('connection.order_feed_restarted', {}, translatorFor('pl'), formatPl).title).toBe(
      catalogues.pl.events.title.connection_order_feed_restarted,
    )
  })

  it('describes a change of the stock settings, with an empty limit as none', () => {
    const payload = { from: { safetyBuffer: 0, channelLimit: null }, to: { safetyBuffer: 2, channelLimit: 1500 } }
    expect(describeEvent('connection.stock_rules_changed', payload, t, format)).toEqual({
      title: 'Stock settings changed',
      detail: 'safety buffer 0 → 2, channel limit none → 1,500',
    })
    expect(describeEvent('connection.stock_rules_changed', { from: 1 }, t, format).detail).toBeNull()
  })

  it('describes Warehouse events and a change of a Channel\'s Warehouses', () => {
    const pl = translatorFor('pl')
    expect(describeEvent('order.reservation_moved', { units: 2, fromWarehouseId: 'a', toWarehouseId: 'b' }, t, format)).toEqual({
      title: 'Reservation moved to another warehouse',
      detail: '2 units',
    })
    expect(describeEvent('connection.warehouses_changed', { to: { all: true, warehouseIds: [] } }, t, format).detail).toBe('all warehouses')
    expect(describeEvent('connection.warehouses_changed', { to: { all: false, warehouseIds: ['a', 'b'] } }, t, format).detail).toBe(
      '2 chosen warehouses',
    )
    expect(describeEvent('connection.warehouses_changed', { to: { all: false, warehouseIds: ['a', 'b', 'c'] } }, pl, formatPl).detail).toBe(
      '3 wybrane magazyny',
    )
    expect(describeEvent('connection.warehouses_changed', { to: 'oops' }, t, format).detail).toBeNull()
    expect(describeEvent('warehouse.created', { name: 'North', priority: 1 }, t, format)).toEqual({ title: 'Warehouse added', detail: 'North' })
    const renamed = { from: { name: 'North', priority: 1 }, to: { name: 'South', priority: 1 } }
    expect(describeEvent('warehouse.updated', renamed, t, format).detail).toBe('North → South')
    const reordered = { from: { name: 'North', priority: 1 }, to: { name: 'North', priority: 1500 } }
    expect(describeEvent('warehouse.updated', reordered, t, format).detail).toBe('priority 1 → 1,500')
    expect(describeEvent('warehouse.deactivated', {}, pl, formatPl)).toEqual({ title: 'Dezaktywowano magazyn', detail: null })
  })

  it('describes Offer publication changes and push rejections', () => {
    expect(describeEvent('offer.channel_status_changed', { from: 'active', to: 'ended', endedReason: 'sold_out', source: 'push' }, t, format)).toEqual({
      title: 'Offer status on the channel changed',
      detail: 'Active → Ended (sold out)',
    })
    expect(describeEvent('offer.channel_status_changed', { from: null, to: 'inactive', endedReason: null }, t, format).detail).toBe('Unknown → Inactive (draft)')
    expect(describeEvent('offer.push_rejected', { push: 'stock', code: 'OFFER_NOT_FOUND' }, t, format)).toEqual({
      title: 'The channel rejected an offer',
      detail: 'stock: OFFER_NOT_FOUND',
    })
    expect(describeEvent('offer.push_rejected', { push: 'price', code: 'X' }, translatorFor('pl'), formatPl).detail).toBe('cena: X')
    expect(describeEvent('offer.push_retried', { push: 'price', actor: { type: 'system' } }, t, format).detail).toBe('price')
    expect(describeEvent('offer.push_rejected', { push: 7, code: {} }, t, format).detail).toBeNull()
  })

  it('pluralises counts the way each language does', () => {
    expect(describeEvent('stock.reserved', { units: 1 }, t, format).detail).toBe('1 unit')
    expect(describeEvent('stock.reserved', { units: 5 }, t, format).detail).toBe('5 units')
    const pl = translatorFor('pl')
    expect(describeEvent('stock.reserved', { units: 1 }, pl, formatPl).detail).toBe('1 sztuka')
    expect(describeEvent('stock.reserved', { units: 3 }, pl, formatPl).detail).toBe('3 sztuki')
    expect(describeEvent('stock.consumed', { units: 5 }, pl, formatPl).detail).toBe('5 sztuk')
    expect(describeEvent('order.imported', { lineCount: 2 }, t, format).detail).toBe('2 lines')
    expect(describeEvent('order.imported', { lineCount: 1 }, t, format).detail).toBe('1 line')
    expect(describeEvent('order.imported', { lineCount: 5 }, pl, formatPl).detail).toBe('5 pozycji')
  })

  it('describes family events with the names and SKUs they carry', () => {
    expect(describeEvent('family.created', { name: 'T-shirt', attributes: ['Size'] }, t, format)).toEqual({ title: 'Product family created', detail: 'T-shirt' })
    expect(describeEvent('family.renamed', { name: { from: 'T-shirt', to: 'Shirt' } }, t, format)).toEqual({ title: 'Product family renamed', detail: 'T-shirt → Shirt' })
    expect(describeEvent('family.product_added', { sku: 'TS-M', productId: 'p' }, t, format)).toEqual({ title: 'Product added to a family', detail: 'TS-M' })
    expect(describeEvent('family.deleted', { name: 5 }, translatorFor('pl'), formatPl)).toEqual({ title: catalogues.pl.events.title.family_deleted, detail: null })
  })

  it('describes Buyer data erasure and retention changes without personal data', () => {
    expect(describeEvent('order.buyer_data_erased', { cause: 'retention', retentionDays: 30 }, t, format)).toEqual({
      title: 'Buyer data erased',
      detail: 'retention period',
    })
    expect(describeEvent('order.buyer_data_erased', { cause: 'erasure_request' }, t, format).detail).toBe('erasure request')
    expect(describeEvent('privacy.retention_changed', { from: null, to: 30 }, t, format).detail).toBe('kept → 30 days')
    expect(describeEvent('privacy.retention_changed', { from: 1, to: null }, t, format).detail).toBe('1 day → kept')
    expect(describeEvent('privacy.erasure_requested', { erased: 2, keptOpen: 1 }, t, format)).toEqual({
      title: 'Erasure request handled',
      detail: '2 orders erased',
    })
    expect(describeEvent('privacy.erasure_requested', { erased: 5 }, translatorFor('pl'), formatPl).detail).toBe('usunięto z 5 zamówień')
  })

  it('shows a value this build does not know as it is', () => {
    expect(describeEvent('order.status_changed', { from: 'new', to: 'teleported' }, t, format).detail).toBe('New → teleported')
    expect(describeEvent('order.channel_fact_recorded', { type: 'exploded' }, t, format).detail).toBe('exploded')
  })

  it('survives payloads of the wrong shape and unknown types', () => {
    expect(describeEvent('stock.set', { from: 'x' }, t, format)).toEqual({ title: 'Stock set', detail: null })
    expect(describeEvent('product.updated', { name: 'oops' }, t, format)).toEqual({ title: 'Product name changed', detail: null })
    expect(describeEvent('something.new', {}, t, format)).toEqual({ title: 'something.new', detail: null })
  })

  it('gives no link without a context, so a caller that only wants the words gets only them', () => {
    expect(describeEvent('order.imported', { externalId: 'A-1', lineCount: 1 }, t, format)).toEqual({ title: 'Order imported', detail: '1 line' })
  })
})

describe('describeEvent with a context', () => {
  const order = { type: 'order', id: 'o1' }
  const product = { type: 'product', id: 'p1' }

  it('links an Event to its subject and names it by the identifier the payload carries', () => {
    expect(describeEvent('order.imported', { connectionId: 'c1', externalId: 'A-1042', lineCount: 2 }, t, format, { subject: order }).link).toEqual({
      href: '/orders/o1',
      kind: 'order',
      noun: 'Order',
      identifier: 'A-1042',
      label: 'Order A-1042',
    })
    expect(describeEvent('product.created', { sku: 'MUG-1', origin: 'manual' }, t, format, { subject: product }).link).toMatchObject({
      href: '/products/p1',
      label: 'Product MUG-1',
    })
    expect(describeEvent('offer.push_rejected', { push: 'stock', code: 'X' }, translatorFor('pl'), formatPl, { subject: { type: 'offer', id: 'f1' } }).link).toMatchObject({
      href: '/products/offers/f1',
      identifier: null,
      label: catalogues.pl.events.view.offer,
    })
  })

  it('prefers what the page knows over the payload, and says "View" when neither names the subject', () => {
    const identifiers = { order: new Map([['o1', 'A-7']]), connection: new Map([['c1', 'Shop']]) }
    expect(describeEvent('order.status_changed', { from: 'new', to: 'processing' }, t, format, { subject: order, identifiers }).link?.label).toBe('Order A-7')
    expect(describeEvent('order.status_changed', { from: 'new', to: 'processing' }, t, format, { subject: order }).link?.label).toBe('View order')
    expect(describeEvent('connection.health_changed', { from: 'ok', to: 'failing' }, t, format, { subject: { type: 'connection', id: 'c1' }, identifiers }).link).toMatchObject({
      href: '/connections/c1',
      label: 'Connection Shop',
    })
  })

  it('never links to the page it is on: there it leads to the other record the payload names', () => {
    const reserved = { orderId: 'o1', orderLineId: 'l1', warehouseId: 'w1', units: 2 }
    // On the dashboard the Product is the subject; on the Product's own history the Order is where to go.
    expect(describeEvent('stock.reserved', reserved, t, format, { subject: product }).link?.href).toBe('/products/p1')
    expect(describeEvent('stock.reserved', reserved, t, format, { subject: product, current: { type: 'product', id: 'p1' } }).link).toMatchObject({
      href: '/orders/o1',
      label: 'View order',
    })
    const linked = { orderLineId: 'l1', productId: 'p1' }
    const onOrder = { subject: order, current: { type: 'order', id: 'o1' } as const, identifiers: { product: new Map([['p1', 'MUG-1']]) } }
    expect(describeEvent('order.line_linked', linked, t, format, onOrder).link).toMatchObject({ href: '/products/p1', label: 'Product MUG-1' })
    expect(describeEvent('order.status_changed', { from: 'new', to: 'processing' }, t, format, onOrder).link).toBeUndefined()
    expect(describeEvent('order.imported', { connectionId: 'c1', externalId: 'A-1' }, t, format, onOrder).link).toMatchObject({ href: '/connections/c1', label: 'View connection' })
  })

  it('links a Warehouse or a Product family only when the page holds its name, since they can be deleted', () => {
    const warehouse = { type: 'warehouse', id: 'w1' }
    expect(describeEvent('warehouse.created', { name: 'North', priority: 1 }, t, format, { subject: warehouse }).link).toBeUndefined()
    expect(describeEvent('warehouse.deleted', { name: 'North' }, t, format, { subject: warehouse, identifiers: { warehouse: new Map() } }).link).toBeUndefined()
    const known = { warehouse: new Map([['w1', 'North']]), product_family: new Map([['f1', 'T-shirt']]) }
    expect(describeEvent('warehouse.updated', {}, t, format, { subject: warehouse, identifiers: known }).link).toMatchObject({ href: '/warehouses/w1', label: 'Warehouse North' })
    expect(describeEvent('family.renamed', {}, t, format, { subject: { type: 'product_family', id: 'f1' }, identifiers: known }).link).toMatchObject({
      href: '/families/f1',
      label: 'Product family T-shirt',
    })
    // The family is gone, so the row leads to the Product it was about, by the SKU the Event kept.
    expect(describeEvent('family.product_removed', { productId: 'p1', sku: 'TS-M' }, t, format, { subject: { type: 'product_family', id: 'gone' } }).link).toMatchObject({
      href: '/products/p1',
      label: 'Product TS-M',
    })
    // A family's Product Event leads to the Product, and says which family where the page knows its name.
    const added = describeEvent('family.product_added', { productId: 'p1', sku: 'TS-M' }, t, format, { subject: { type: 'product_family', id: 'f1' }, identifiers: known })
    expect(added).toMatchObject({ detail: 'T-shirt', link: { href: '/products/p1', label: 'Product TS-M' } })
    const onFamilyPage = describeEvent('family.product_added', { productId: 'p1', sku: 'TS-M' }, t, format, {
      subject: { type: 'product_family', id: 'f1' },
      current: { type: 'product_family', id: 'f1' },
      identifiers: known,
    })
    expect(onFamilyPage).toMatchObject({ detail: null, link: { href: '/products/p1', label: 'Product TS-M' } })
    // Stock set in a Warehouse the Product's page lists: its history points there.
    const set = { warehouseId: 'w1', from: 1, to: 2 }
    expect(describeEvent('stock.set', set, t, format, { subject: product, current: { type: 'product', id: 'p1' }, identifiers: known }).link?.label).toBe('Warehouse North')
    expect(describeEvent('stock.set', set, t, format, { subject: product, current: { type: 'product', id: 'p1' } }).link).toBeUndefined()
  })

  it('has no link for a subject without a page, a malformed one, or an Event about the organization', () => {
    expect(describeEvent('order_status.created', { name: 'Packed' }, t, format, { subject: { type: 'order_status', id: 's1' } }).link).toBeUndefined()
    expect(describeEvent('privacy.retention_changed', { from: null, to: 30 }, t, format, { subject: null }).link).toBeUndefined()
    expect(describeEvent('stock.reserved', { orderId: 7, units: 1 }, t, format, { subject: { type: 'product', id: '' } }).link).toBeUndefined()
  })

  it('keeps Buyer data and other payload text out of the link: only the identifiers it is told to read', () => {
    const payload = { externalId: 'A-1', buyerName: 'Jan Kowalski', email: 'jan@example.test', name: 'Jan Kowalski' }
    const described = describeEvent('order.status_changed', payload, t, format, { subject: order })
    expect(JSON.stringify(described)).not.toContain('Kowalski')
    expect(JSON.stringify(described)).not.toContain('example.test')
    // Only the import Event's own externalId is read as an Order number.
    expect(described.link?.identifier).toBeNull()
  })
})

describe('eventRefsToResolve', () => {
  it('lists, by kind and once each, the records whose identifier the payloads do not carry', () => {
    const refs = eventRefsToResolve([
      { type: 'order.imported', subject: { type: 'order', id: 'o1' }, payload: { connectionId: 'c1', externalId: 'A-1' } },
      { type: 'order.status_changed', subject: { type: 'order', id: 'o2' }, payload: {} },
      { type: 'order.status_changed', subject: { type: 'order', id: 'o2' }, payload: {} },
      { type: 'stock.reserved', subject: { type: 'product', id: 'p1' }, payload: { orderId: 'o3', warehouseId: 'w1' } },
      { type: 'product.created', subject: { type: 'product', id: 'p2' }, payload: { sku: 'MUG-1' } },
      { type: 'warehouse.created', subject: { type: 'warehouse', id: 'w2' }, payload: { name: 'North' } },
      { type: 'system.ping', subject: null, payload: { requestedBy: 'someone@example.test' } },
    ])
    expect(refs).toEqual({ order: ['o2', 'o3'], product: ['p1'], offer: [], connection: ['c1'], warehouse: ['w1', 'w2'], product_family: [] })
  })
})
