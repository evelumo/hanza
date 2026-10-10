import { PermanentError } from '@hanza/connector-sdk'
import type { Position } from './orders-stream'

// The Order feed's cursor. WooCommerce has no journal, so the cursor says where the feed is in two lists of
// order snapshots:
//
//   l1:<start>:<boundary>:<second>:<id>:<rank>                  the open orders, by creation time
//   c1:<start>:<boundary>:<second>:<id>:<rank>:<trash rank>     the changes, by modification time
//
// <start> is the shop's time (seconds since the epoch) the changes are read from once the listing is done, and
// <boundary> the highest order id when the feed started; both stay the same for the life of the feed.
// <second>:<id> is the last entry of the list that was dealt with, and a rank how many entries of that same second
// were (for the changes, one for the list of live orders and one for the trash). All whole numbers, in decimal;
// <second> alone may be negative, for an order a shop dates before 1970: whatever the encoder writes, the parser
// reads, or one such order would stop the feed for good (nothing but an expired cursor restarts it).

export interface ListingCursor {
  phase: 'listing'
  start: number
  boundary: number
  at: Position
  rank: number
}

export interface ChangesCursor {
  phase: 'changes'
  start: number
  boundary: number
  at: Position
  ranks: { live: number; trash: number }
}

export type FeedCursor = ListingCursor | ChangesCursor

// No leading zero, no fraction, a sign only on the second: one cursor has one spelling, so "nothing new" can return it unchanged.
const NUMBER = '(0|[1-9]\\d{0,15})'
const SECOND = '(0|-?[1-9]\\d{0,15})'
const LISTING = new RegExp(`^l1:${NUMBER}:${NUMBER}:${SECOND}:${NUMBER}:${NUMBER}$`)
const CHANGES = new RegExp(`^c1:${NUMBER}:${NUMBER}:${SECOND}:${NUMBER}:${NUMBER}:${NUMBER}$`)

export function encodeCursor(cursor: FeedCursor): string {
  const { start, boundary, at } = cursor
  return cursor.phase === 'listing'
    ? `l1:${start}:${boundary}:${at.second}:${at.id}:${cursor.rank}`
    : `c1:${start}:${boundary}:${at.second}:${at.id}:${cursor.ranks.live}:${cursor.ranks.trash}`
}

/** The cursor a listing starts with: nothing listed yet. */
export function listingStart(start: number, boundary: number): ListingCursor {
  return { phase: 'listing', start, boundary, at: { second: 0, id: 0 }, rank: 0 }
}

/** The cursor the changes start with: everything stamped in the second `start` or later is still to be read. */
export function changesStart(start: number, boundary: number): ChangesCursor {
  return { phase: 'changes', start, boundary, at: { second: start, id: 0 }, ranks: { live: 0, trash: 0 } }
}

/**
 * Reads a cursor this connector wrote. Anything else is a `PermanentError`: WooCommerce keeps its orders for ever,
 * so there is no position the shop "no longer has", and a restart of the feed would hide the real fault.
 */
export function parseCursor(cursor: string): FeedCursor {
  const match = LISTING.exec(cursor) ?? CHANGES.exec(cursor)
  const numbers = match?.slice(1).map(Number) ?? []
  if (match === null || !numbers.every(Number.isSafeInteger)) {
    throw new PermanentError('The Order feed cursor was not written by this version of the WooCommerce connector')
  }
  const [start = 0, boundary = 0, second = 0, id = 0, rank = 0, trashRank = 0] = numbers
  const at = { second, id }
  return cursor.startsWith('l1:')
    ? { phase: 'listing', start, boundary, at, rank }
    : { phase: 'changes', start, boundary, at, ranks: { live: rank, trash: trashRank } }
}
