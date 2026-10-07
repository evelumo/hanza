import { describe, expect, it } from 'vitest'
import { catalogues } from '@/i18n/catalogues'
import { translatorFor } from '@/i18n/testing'
import { createFormatters } from './format'
import { describeEvent } from './events'

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
    expect(describeEvent('stock.set', { from: 1000, to: 1200 }, t, format).detail).toBe('1,000 → 1,200')
    expect(describeEvent('stock.set', { from: 10000, to: 12500 }, translatorFor('pl'), formatPl)?.detail?.replace(/\s/g, ' ')).toBe('10 000 → 12 500')
    expect(describeEvent('connection.health_changed', { from: 'unknown', to: 'ok' }, t, format).detail).toBe('Not checked → Working')
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
})
