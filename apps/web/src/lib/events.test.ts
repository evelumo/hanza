import { describe, expect, it } from 'vitest'
import { catalogues } from '@/i18n/catalogues'
import { translatorFor } from '@/i18n/testing'
import { createFormatters } from './format'
import { describeEvent } from './events'

const t = translatorFor('en')
const format = createFormatters('en')
const formatPl = createFormatters('pl')

describe('describeEvent', () => {
  it('describes a status change with the status labels', () => {
    expect(describeEvent('order.status_changed', { from: 'new', to: 'shipped' }, t, format)).toEqual({ title: 'Status changed', detail: 'New → Shipped' })
    const { orderStatus } = catalogues.pl.labels
    expect(describeEvent('order.status_changed', { from: 'new', to: 'shipped' }, translatorFor('pl'), formatPl)).toEqual({
      title: catalogues.pl.events.title.order_status_changed,
      detail: `${orderStatus.new} → ${orderStatus.shipped}`,
    })
    expect(orderStatus.new).not.toBe(catalogues.en.labels.orderStatus.new)
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
