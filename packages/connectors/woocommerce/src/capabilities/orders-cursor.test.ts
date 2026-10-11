import { classifyConnectorError, isCursorExpiredError } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { changesStart, encodeCursor, listingStart, parseCursor, secondStart, type FeedCursor } from './orders-cursor'

const listing: FeedCursor = { phase: 'listing', start: 1791633098, boundary: 57, at: { second: 1789972200, id: 33 }, rank: 1 }
const changes: FeedCursor = { phase: 'changes', start: 1791633098, boundary: 57, at: { second: 1791633140, id: 58 }, ranks: { live: 2, trash: 0 } }

describe('the Order feed cursor', () => {
  it('writes the phase and its version first, then the start, the boundary and the position', () => {
    expect(encodeCursor(listing)).toBe('l1:1791633098:57:1789972200:33:1')
    expect(encodeCursor(changes)).toBe('c1:1791633098:57:1791633140:58:2:0')
  })

  it.each([listing, changes, listingStart(1791633098, 0), changesStart(1791633098, 57)])('reads back what it wrote: %j', (cursor) => {
    expect(parseCursor(encodeCursor(cursor))).toEqual(cursor)
  })

  it('has one spelling per cursor, so a feed with nothing new can hand the same string back', () => {
    for (const text of ['l1:1791633098:57:0:0:0', 'c1:1791633098:57:1791633098:0:0:0']) {
      expect(encodeCursor(parseCursor(text))).toBe(text)
    }
  })

  it('carries a position before 1970, so an order a shop dates that way cannot stop the feed', () => {
    const early: FeedCursor = { phase: 'listing', start: 1791633098, boundary: 57, at: { second: -3600, id: 12 }, rank: 1 }
    expect(encodeCursor(early)).toBe('l1:1791633098:57:-3600:12:1')
    expect(parseCursor('l1:1791633098:57:-3600:12:1')).toEqual(early)
    expect(parseCursor('c1:1791633098:57:-1:12:1:0')).toMatchObject({ phase: 'changes', at: { second: -1, id: 12 } })
  })

  it('reads back every position the API\'s dates and ids can give', () => {
    // The years a `YYYY-MM-DDTHH:MM:SS` date can name, the ids a JSON number can carry exactly, and everything between.
    const seconds = ['0000-01-01T00:00:00', '0001-01-01T00:00:00', '1969-12-31T23:59:59', '1970-01-01T00:00:00', '2026-10-10T18:51:38', '9999-12-31T23:59:59'].map((gmt) => Date.parse(`${gmt}Z`) / 1000)
    const ids = [0, 1, 57, 2 ** 31, Number.MAX_SAFE_INTEGER]
    for (const second of seconds) {
      expect(Number.isSafeInteger(second)).toBe(true)
      for (const id of ids) {
        for (const cursor of [
          { phase: 'listing', start: 1791633098, boundary: id, at: { second, id }, rank: 100 },
          { phase: 'changes', start: 1791633098, boundary: id, at: { second, id }, ranks: { live: 100, trash: 3 } },
          { phase: 'second', start: 1791633098, boundary: id, at: { second, id }, ranks: { live: 100, trash: 3 } },
        ] satisfies FeedCursor[]) {
          expect(parseCursor(encodeCursor(cursor))).toEqual(cursor)
          expect(encodeCursor(parseCursor(encodeCursor(cursor)))).toBe(encodeCursor(cursor))
        }
      }
    }
  })

  it('has a cursor of its own for one second of the changes read by id', () => {
    const second: FeedCursor = { phase: 'second', start: 1791633098, boundary: 57, at: { second: 1791633140, id: 41 }, ranks: { live: 3, trash: 0 } }
    expect(encodeCursor(second)).toBe('s1:1791633098:57:1791633140:41:3:0')
    expect(parseCursor('s1:1791633098:57:1791633140:41:3:0')).toEqual(second)
    // It begins with nothing of the second dealt with.
    expect(encodeCursor(secondStart(1791633098, 57, 1791633140))).toBe('s1:1791633098:57:1791633140:0:0:0')
    // The same numbers under `c1:` are another place in the feed.
    expect(parseCursor('c1:1791633098:57:1791633140:41:3:0').phase).toBe('changes')
    for (const text of ['s1:1791633098:57:1791633140:41:3', 's2:1791633098:57:1791633140:41:3:0', 's1:1791633098:57:1791633140:41:3:0:0']) {
      expect(() => parseCursor(text)).toThrow(/cursor/)
    }
  })

  it('stays short', () => {
    expect(encodeCursor(changes).length).toBeLessThan(50)
  })

  it('starts a listing with nothing listed, and the changes at the start with nothing read', () => {
    expect(encodeCursor(listingStart(1791633098, 57))).toBe('l1:1791633098:57:0:0:0')
    // Every entry of the start's own second is behind id 0.
    expect(encodeCursor(changesStart(1791633098, 57))).toBe('c1:1791633098:57:1791633098:0:0:0')
  })

  it.each([
    ['nothing', ''],
    ['another connector\'s cursor', 'e1:1700000000:2026-10-10T18:51:38Z'],
    ['a later version of its own', 'l2:1791633098:57:0:0:0'],
    ['a listing cursor with a field missing', 'l1:1791633098:57:0:0'],
    ['a listing cursor with a field too many', 'l1:1791633098:57:0:0:0:0'],
    ['a changes cursor with a field missing', 'c1:1791633098:57:1791633098:0:0'],
    ['a negative start', 'c1:-1791633098:57:1791633098:0:0:0'],
    ['a negative boundary', 'l1:1791633098:-57:0:0:0'],
    ['a negative id', 'c1:1791633098:57:1791633098:-4:0:0'],
    ['a negative rank', 'l1:1791633098:57:0:0:-1'],
    ['a negative zero', 'l1:1791633098:57:-0:0:0'],
    ['a sign of its own', 'l1:1791633098:57:-:0:0'],
    ['a fraction', 'c1:1791633098.5:57:1791633098:0:0:0'],
    ['a number spelled another way', 'c1:1791633098:057:1791633098:0:0:0'],
    ['a number in another notation', 'c1:1e9:57:1791633098:0:0:0'],
    ['a number too large to be exact', 'c1:9999999999999999:57:1791633098:0:0:0'],
    ['space around it', ' l1:1791633098:57:0:0:0'],
    ['a second cursor behind it', 'l1:1791633098:57:0:0:0\nl1:1:1:0:0:0'],
    ['a date where the position goes', 'c1:1791633098:57:2026-10-10T18:51:38Z:0:0:0'],
  ])('refuses %s', (_, text) => {
    expect(() => parseCursor(text)).toThrow(/cursor/)
    try {
      parseCursor(text)
    } catch (error) {
      // Permanent, and not "expired": WooCommerce never loses a position, so a restart would hide a fault.
      expect(classifyConnectorError(error).kind).toBe('permanent')
      expect(isCursorExpiredError(error)).toBe(false)
      expect((error as Error).message).not.toContain(text === '' ? '\u0000' : text)
    }
  })
})
