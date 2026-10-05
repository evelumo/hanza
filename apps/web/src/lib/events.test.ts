import { describe, expect, it } from 'vitest'
import { catalogues } from '@/i18n/catalogues'
import { translatorFor } from '@/i18n/testing'
import { describeEvent } from './events'

const t = translatorFor('en')

describe('describeEvent', () => {
  it('describes a status change with the status labels', () => {
    expect(describeEvent('order.status_changed', { from: 'new', to: 'shipped' }, t)).toEqual({ title: 'Status changed', detail: 'New → Shipped' })
    const { orderStatus } = catalogues.pl.labels
    expect(describeEvent('order.status_changed', { from: 'new', to: 'shipped' }, translatorFor('pl'))).toEqual({
      title: catalogues.pl.events.title.order_status_changed,
      detail: `${orderStatus.new} → ${orderStatus.shipped}`,
    })
    expect(orderStatus.new).not.toBe(catalogues.en.labels.orderStatus.new)
  })

  it('describes stock and health changes', () => {
    expect(describeEvent('stock.set', { from: 3, to: 10 }, t).detail).toBe('3 → 10')
    expect(describeEvent('connection.health_changed', { from: 'unknown', to: 'ok' }, t).detail).toBe('Not checked → Working')
    expect(describeEvent('order.attention_raised', { reasons: ['unmatched_line', 'shortage'] }, t).detail).toBe('Unlinked line, Shortage')
  })

  it('pluralises counts the way each language does', () => {
    expect(describeEvent('stock.reserved', { units: 1 }, t).detail).toBe('1 unit')
    expect(describeEvent('stock.reserved', { units: 5 }, t).detail).toBe('5 units')
    const pl = translatorFor('pl')
    expect(describeEvent('stock.reserved', { units: 1 }, pl).detail).toBe('1 sztuka')
    expect(describeEvent('stock.reserved', { units: 3 }, pl).detail).toBe('3 sztuki')
    expect(describeEvent('stock.consumed', { units: 5 }, pl).detail).toBe('5 sztuk')
    expect(describeEvent('order.imported', { lineCount: 2 }, t).detail).toBe('2 lines')
    expect(describeEvent('order.imported', { lineCount: 1 }, t).detail).toBe('1 line')
    expect(describeEvent('order.imported', { lineCount: 5 }, pl).detail).toBe('5 pozycji')
  })

  it('shows a value this build does not know as it is', () => {
    expect(describeEvent('order.status_changed', { from: 'new', to: 'teleported' }, t).detail).toBe('New → teleported')
    expect(describeEvent('order.channel_fact_recorded', { type: 'exploded' }, t).detail).toBe('exploded')
  })

  it('survives payloads of the wrong shape and unknown types', () => {
    expect(describeEvent('stock.set', { from: 'x' }, t)).toEqual({ title: 'Stock set', detail: null })
    expect(describeEvent('product.updated', { name: 'oops' }, t)).toEqual({ title: 'Product name changed', detail: null })
    expect(describeEvent('something.new', {}, t)).toEqual({ title: 'something.new', detail: null })
  })
})
