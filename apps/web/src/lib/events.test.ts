import { describe, expect, it } from 'vitest'
import { catalogues } from '@/i18n/catalogues'
import { translatorFor } from '@/i18n/testing'
import { createFormatters } from './format'
import { describeEvent } from './events'

const t = translatorFor('en')
const number = createFormatters('en').number
const numberPl = createFormatters('pl').number

describe('describeEvent', () => {
  it('describes a status change with the phase names when the Event has no status names', () => {
    expect(describeEvent('order.status_changed', { from: 'new', to: 'shipped' }, t, number)).toEqual({ title: 'Status changed', detail: 'New → Shipped' })
    const { orderPhase } = catalogues.pl.labels
    expect(describeEvent('order.status_changed', { from: 'new', to: 'shipped' }, translatorFor('pl'), numberPl)).toEqual({
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
    expect(describeEvent('order.status_changed', payload, t, number).detail).toBe('Waiting for packaging → Packed')
    const toDefault = { from: 'processing', to: 'shipped', fromStatus: { id: 'b', name: 'Packed' }, toStatus: { id: 'c', name: null } }
    expect(describeEvent('order.status_changed', toDefault, translatorFor('pl'), numberPl).detail).toBe(`Packed → ${catalogues.pl.labels.orderPhase.shipped}`)
    expect(describeEvent('order.status_changed', { from: 'new', to: 'new', toStatus: 'garbage' }, t, number).detail).toBe('New → New')
  })

  it('shows an unnamed status by the phase it kept, in the viewer\'s language', () => {
    const payload = { from: 'processing', to: 'processing', fromStatus: { id: 'a', name: null, phase: 'processing' }, toStatus: { id: 'b', name: 'Packed', phase: 'processing' } }
    expect(describeEvent('order.status_changed', payload, translatorFor('pl'), numberPl).detail).toBe(`${catalogues.pl.labels.orderPhase.processing} → Packed`)
    expect(describeEvent('order.status_changed', payload, t, number).detail).toBe('Processing → Packed')
  })

  it('shows a former default (no name) in a Status mapping change as its phase, and no status as the default', () => {
    const formerDefault = { phase: 'new', from: { id: 'x', name: null, phase: 'new' }, to: { id: 'y', name: 'To check', phase: 'new' } }
    expect(describeEvent('connection.status_mapping_changed', formerDefault, t, number).detail).toBe('New: New → To check')
    expect(describeEvent('connection.status_mapping_changed', { phase: 'new', from: { id: 'y', name: 'To check', phase: 'new' }, to: null }, t, number).detail).toBe(
      'New: To check → default status',
    )
  })

  it('describes a change of a Status mapping', () => {
    const payload = { phase: 'cancelled', from: null, to: { id: 'x', name: 'Refunded' } }
    expect(describeEvent('connection.status_mapping_changed', payload, t, number)).toEqual({
      title: 'Order statuses from the channel changed',
      detail: 'Cancelled: default status → Refunded',
    })
  })

  it('describes stock and health changes', () => {
    expect(describeEvent('stock.set', { from: 3, to: 10 }, t, number).detail).toBe('3 → 10')
    expect(describeEvent('stock.set', { from: 1000, to: 1200 }, t, number).detail).toBe('1,000 → 1,200')
    expect(describeEvent('stock.set', { from: 10000, to: 12500 }, translatorFor('pl'), numberPl)?.detail?.replace(/\s/g, ' ')).toBe('10 000 → 12 500')
    expect(describeEvent('connection.health_changed', { from: 'unknown', to: 'ok' }, t, number).detail).toBe('Not checked → Working')
    expect(describeEvent('order.attention_raised', { reasons: ['unmatched_line', 'shortage'] }, t, number).detail).toBe('Unmatched line, Shortage')
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
