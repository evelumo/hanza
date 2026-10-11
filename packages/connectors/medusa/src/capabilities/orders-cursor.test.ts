import { isCursorExpiredError, PermanentError } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor, isAfterBoundary, type OrdersCursor } from './orders-cursor'

const boundary = { time: '2026-10-11T10:00:00.123Z', id: 'order_01B' }

describe('the Order feed cursor', () => {
  it.each<OrdersCursor>([
    { phase: 'listing', position: 980, boundary, lastTime: null, seen: [], tie: null },
    { phase: 'listing', position: 0, boundary, lastTime: '2026-10-11T09:00:00.000Z', seen: ['order_01A', 'order:with,odd%chars'], tie: null },
    { phase: 'listing', position: 7, boundary, lastTime: '2026-10-11T09:00:00.000Z', seen: ['order_01A'], tie: 50 },
    { phase: 'journal', position: 981, boundary },
    { phase: 'journal', position: 0, boundary: null },
  ])('reads back what it wrote: %j', (cursor) => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor)
  })

  it('is versioned and says its phase', () => {
    expect(encodeCursor({ phase: 'journal', position: 5, boundary })).toBe('e1:5:2026-10-11T10%3A00%3A00.123Z:order_01B')
    expect(encodeCursor({ phase: 'listing', position: 5, boundary, lastTime: null, seen: [], tie: null })).toBe('l1:5:2026-10-11T10%3A00%3A00.123Z:order_01B:::')
  })

  it.each([
    '',
    'x',
    'e1:5',
    'e2:5::',
    'e1:-1::',
    'e1:05::',
    'e1:abc::',
    'e1:5:not-a-time:order_1',
    'e1:5:2026-10-11T10%3A00%3A00Z:',
    'l1:5::::::',
    'l1:5:2026-10-11T10%3A00%3A00Z:o::a:',
    'l1:5:2026-10-11T10%3A00%3A00Z:o:2026-10-11T10%3A00%3A00Z:a,,b:',
    'l1:5:2026-10-11T10%3A00%3A00Z:o:2026-10-11T10%3A00%3A00Z::x',
    'e1:5:%E0%A4%A::',
  ])('refuses %j as a PermanentError, never as an expired cursor', (text) => {
    let error: unknown
    try {
      decodeCursor(text)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(PermanentError)
    expect(isCursorExpiredError(error)).toBe(false)
  })
})

describe('isAfterBoundary', () => {
  it('compares the creation time, then the id', () => {
    expect(isAfterBoundary({ created_at: '2026-10-11T10:00:00.124Z', id: 'order_01A' }, boundary)).toBe(true)
    expect(isAfterBoundary({ created_at: '2026-10-11T10:00:00.122Z', id: 'order_01Z' }, boundary)).toBe(false)
    expect(isAfterBoundary({ created_at: '2026-10-11T10:00:00.123Z', id: 'order_01C' }, boundary)).toBe(true)
    expect(isAfterBoundary({ created_at: '2026-10-11T10:00:00.123Z', id: 'order_01B' }, boundary)).toBe(false)
    expect(isAfterBoundary({ created_at: '2026-10-11T12:00:00.123+02:00', id: 'order_01C' }, boundary)).toBe(true)
  })

  it('puts every order after a store that had none', () => {
    expect(isAfterBoundary({ created_at: '2000-01-01T00:00:00.000Z', id: 'order_01A' }, null)).toBe(true)
  })
})
