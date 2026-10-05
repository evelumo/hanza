import { describe, expect, it } from 'vitest'
import { catalogues } from '@/i18n/catalogues'
import { translatorFor } from '@/i18n/testing'
import { createFormatters } from './format'
import { describeEvent } from './events'

const t = translatorFor('en')
const number = createFormatters('en').number
const numberPl = createFormatters('pl').number

describe('describeEvent', () => {
  it('describes a status change with the status labels', () => {
    expect(describeEvent('order.status_changed', { from: 'new', to: 'shipped' }, t, number)).toEqual({ title: 'Status changed', detail: 'New → Shipped' })
    const { orderStatus } = catalogues.pl.labels
    expect(describeEvent('order.status_changed', { from: 'new', to: 'shipped' }, translatorFor('pl'), numberPl)).toEqual({
      title: catalogues.pl.events.title.order_status_changed,
      detail: `${orderStatus.new} → ${orderStatus.shipped}`,
    })
    expect(orderStatus.new).not.toBe(catalogues.en.labels.orderStatus.new)
  })

  it('describes stock and health changes', () => {
    expect(describeEvent('stock.set', { from: 3, to: 10 }, t, number).detail).toBe('3 → 10')
    expect(describeEvent('stock.set', { from: 1000, to: 1200 }, t, number).detail).toBe('1,000 → 1,200')
    expect(describeEvent('stock.set', { from: 10000, to: 12500 }, translatorFor('pl'), numberPl)?.detail?.replace(/\s/g, ' ')).toBe('10 000 → 12 500')
    expect(describeEvent('connection.health_changed', { from: 'unknown', to: 'ok' }, t, number).detail).toBe('Not checked → Working')
    expect(describeEvent('order.attention_raised', { reasons: ['unmatched_line', 'shortage'] }, t, number).detail).toBe('Unmatched line, Shortage')
  })

  it('describes a change of the stock settings, with an empty limit as none', () => {
    const payload = { from: { safetyBuffer: 0, channelLimit: null }, to: { safetyBuffer: 2, channelLimit: 1500 } }
    expect(describeEvent('connection.stock_rules_changed', payload, t, number)).toEqual({
      title: 'Stock settings changed',
      detail: 'safety buffer 0 → 2, channel limit none → 1,500',
    })
    expect(describeEvent('connection.stock_rules_changed', { from: 1 }, t, number).detail).toBeNull()
  })

  it('describes Warehouse events and a change of a Channel\'s Warehouses', () => {
    const pl = translatorFor('pl')
    expect(describeEvent('order.reservation_moved', { units: 2, fromWarehouseId: 'a', toWarehouseId: 'b' }, t, number)).toEqual({
      title: 'Reservation moved to another warehouse',
      detail: '2 units',
    })
    expect(describeEvent('connection.warehouses_changed', { to: { all: true, warehouseIds: [] } }, t, number).detail).toBe('all warehouses')
    expect(describeEvent('connection.warehouses_changed', { to: { all: false, warehouseIds: ['a', 'b'] } }, t, number).detail).toBe(
      '2 chosen warehouses',
    )
    expect(describeEvent('connection.warehouses_changed', { to: { all: false, warehouseIds: ['a', 'b', 'c'] } }, pl, numberPl).detail).toBe(
      '3 wybrane magazyny',
    )
    expect(describeEvent('connection.warehouses_changed', { to: 'oops' }, t, number).detail).toBeNull()
    expect(describeEvent('warehouse.created', { name: 'North', priority: 1 }, t, number)).toEqual({ title: 'Warehouse added', detail: 'North' })
    const renamed = { from: { name: 'North', priority: 1 }, to: { name: 'South', priority: 1 } }
    expect(describeEvent('warehouse.updated', renamed, t, number).detail).toBe('North → South')
    const reordered = { from: { name: 'North', priority: 1 }, to: { name: 'North', priority: 1500 } }
    expect(describeEvent('warehouse.updated', reordered, t, number).detail).toBe('priority 1 → 1,500')
    expect(describeEvent('warehouse.deactivated', {}, pl, numberPl)).toEqual({ title: 'Dezaktywowano magazyn', detail: null })
  })

  it('pluralises counts the way each language does', () => {
    expect(describeEvent('stock.reserved', { units: 1 }, t, number).detail).toBe('1 unit')
    expect(describeEvent('stock.reserved', { units: 5 }, t, number).detail).toBe('5 units')
    const pl = translatorFor('pl')
    expect(describeEvent('stock.reserved', { units: 1 }, pl, numberPl).detail).toBe('1 sztuka')
    expect(describeEvent('stock.reserved', { units: 3 }, pl, numberPl).detail).toBe('3 sztuki')
    expect(describeEvent('stock.consumed', { units: 5 }, pl, numberPl).detail).toBe('5 sztuk')
    expect(describeEvent('order.imported', { lineCount: 2 }, t, number).detail).toBe('2 lines')
    expect(describeEvent('order.imported', { lineCount: 1 }, t, number).detail).toBe('1 line')
    expect(describeEvent('order.imported', { lineCount: 5 }, pl, numberPl).detail).toBe('5 pozycji')
  })

  it('shows a value this build does not know as it is', () => {
    expect(describeEvent('order.status_changed', { from: 'new', to: 'teleported' }, t, number).detail).toBe('New → teleported')
    expect(describeEvent('order.channel_fact_recorded', { type: 'exploded' }, t, number).detail).toBe('exploded')
  })

  it('survives payloads of the wrong shape and unknown types', () => {
    expect(describeEvent('stock.set', { from: 'x' }, t, number)).toEqual({ title: 'Stock set', detail: null })
    expect(describeEvent('product.updated', { name: 'oops' }, t, number)).toEqual({ title: 'Product name changed', detail: null })
    expect(describeEvent('something.new', {}, t, number)).toEqual({ title: 'something.new', detail: null })
  })
})
