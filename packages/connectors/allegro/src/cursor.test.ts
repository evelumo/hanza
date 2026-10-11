import { PermanentError } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor } from './cursor'
import type { OrdersCursor } from './cursor'

const boughtBefore = '2026-10-10T12:00:00.000Z'

describe('encodeCursor / decodeCursor', () => {
  it.each<[string, OrdersCursor]>([
    ['a listing cursor before its first page', { phase: 'listing', eventId: '1791663869066571', boughtBefore, lastBoughtAt: null }],
    [
      'a listing cursor after a page',
      { phase: 'listing', eventId: '1791663869066571', boughtBefore, lastBoughtAt: '2026-10-01T09:00:00.000Z' },
    ],
    ['a listing cursor of an empty journal', { phase: 'listing', eventId: null, boughtBefore, lastBoughtAt: null }],
    ['a journal cursor', { phase: 'journal', eventId: '1791663869066571', boughtBefore }],
    ['a journal cursor of an empty journal', { phase: 'journal', eventId: null, boughtBefore }],
    ['an event id with separators and other characters', { phase: 'journal', eventId: 'a:b/c+d=%20 ż:', boughtBefore }],
  ])('round-trips %s', (_label, cursor) => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor)
  })

  it('writes the phase as a versioned prefix', () => {
    expect(encodeCursor({ phase: 'listing', eventId: 'e', boughtBefore, lastBoughtAt: null })).toBe(
      'l1:e:2026-10-10T12%3A00%3A00.000Z:',
    )
    expect(encodeCursor({ phase: 'journal', eventId: null, boughtBefore })).toBe('e1::2026-10-10T12%3A00%3A00.000Z')
  })

  it('round-trips an offset boundary', () => {
    const cursor: OrdersCursor = { phase: 'journal', eventId: 'x', boughtBefore: '2026-10-10T14:00:00+02:00' }
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor)
  })

  it.each([
    ['an empty string', ''],
    ['an unknown prefix', 'x1:e:2026-10-10T12%3A00%3A00.000Z'],
    ['a future version', 'e2:e:2026-10-10T12%3A00%3A00.000Z'],
    ['a missing field', 'l1:e:2026-10-10T12%3A00%3A00.000Z'],
    ['an extra field', 'e1:e:2026-10-10T12%3A00%3A00.000Z:x'],
    ['no boundary', 'e1:e:'],
    ['a boundary that is not a date', 'e1:e:yesterday'],
    ['a last key that is not a date', 'l1:e:2026-10-10T12%3A00%3A00.000Z:soon'],
    ['a broken escape', 'e1:%E0%A4%A:2026-10-10T12%3A00%3A00.000Z'],
  ])('refuses %s as permanent, not expired', (_label, text) => {
    expect(() => decodeCursor(text)).toThrow(PermanentError)
    try {
      decodeCursor(text)
    } catch (error) {
      expect((error as Error).name).toBe('PermanentError')
    }
  })
})
