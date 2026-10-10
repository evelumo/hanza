import { PermanentError } from '@hanza/connector-sdk'
import { z } from 'zod'

/**
 * Position in the Order feed (ADR 0021). `eventId` is the journal position taken when the feed started (null for a
 * seller whose journal was empty then); `boughtBefore` is the frozen boundary between Orders listed at the start and
 * Orders the journal sends in full. While listing, `lastBoughtAt` is the keyset: the `boughtAt` of the last Order
 * listed (null before the first page).
 */
export type OrdersCursor =
  | { phase: 'listing'; eventId: string | null; boughtBefore: string; lastBoughtAt: string | null }
  | { phase: 'journal'; eventId: string | null; boughtBefore: string }

const LISTING = 'l1'
const JOURNAL = 'e1'
const isoDateTime = z.iso.datetime({ offset: true })

// Every field is URI-encoded, so the `:` separator never appears inside one; an absent field is the empty string.
function field(value: string | null): string {
  return value === null ? '' : encodeURIComponent(value)
}

export function encodeCursor(cursor: OrdersCursor): string {
  if (cursor.phase === 'listing') {
    return [LISTING, field(cursor.eventId), field(cursor.boughtBefore), field(cursor.lastBoughtAt)].join(':')
  }
  return [JOURNAL, field(cursor.eventId), field(cursor.boughtBefore)].join(':')
}

// The core stores the cursor this connector wrote, so one it cannot read is a bug, not an expired position.
function unreadable(): PermanentError {
  return new PermanentError('Unreadable Allegro Order feed cursor')
}

function decodeField(text: string): string | null {
  if (text === '') return null
  try {
    return decodeURIComponent(text)
  } catch {
    throw unreadable()
  }
}

function dateTime(value: string | null): string {
  if (value === null || !isoDateTime.safeParse(value).success) throw unreadable()
  return value
}

export function decodeCursor(text: string): OrdersCursor {
  const [prefix, ...fields] = text.split(':')
  if (prefix === LISTING && fields.length === 3) {
    const [eventId, boughtBefore, lastBoughtAt] = fields.map(decodeField) as [string | null, string | null, string | null]
    return {
      phase: 'listing',
      eventId,
      boughtBefore: dateTime(boughtBefore),
      lastBoughtAt: lastBoughtAt === null ? null : dateTime(lastBoughtAt),
    }
  }
  if (prefix === JOURNAL && fields.length === 2) {
    const [eventId, boughtBefore] = fields.map(decodeField) as [string | null, string | null]
    return { phase: 'journal', eventId, boughtBefore: dateTime(boughtBefore) }
  }
  throw unreadable()
}
