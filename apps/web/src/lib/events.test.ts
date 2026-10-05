import { describe, expect, it } from 'vitest'
import { describeEvent } from './events'

describe('describeEvent', () => {
  it('describes a status change with the Polish status labels', () => {
    expect(describeEvent('order.status_changed', { from: 'new', to: 'shipped' })).toEqual({ title: 'Zmieniono status', detail: 'Nowe → Wysłane' })
  })

  it('describes stock and health changes', () => {
    expect(describeEvent('stock.set', { from: 3, to: 10 }).detail).toBe('3 → 10')
    expect(describeEvent('connection.health_changed', { from: 'unknown', to: 'ok' }).detail).toBe('Nie sprawdzono → Działa')
    expect(describeEvent('order.attention_raised', { reasons: ['unmatched_line', 'shortage'] }).detail).toBe('Niepołączona pozycja, Brak na stanie')
  })

  it('survives payloads of the wrong shape and unknown types', () => {
    expect(describeEvent('stock.set', { from: 'x' })).toEqual({ title: 'Ustawiono stan', detail: null })
    expect(describeEvent('product.updated', { name: 'oops' })).toEqual({ title: 'Zmieniono nazwę produktu', detail: null })
    expect(describeEvent('something.new', {})).toEqual({ title: 'something.new', detail: null })
  })
})
