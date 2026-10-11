import { PermanentError } from '@hanza/connector-sdk'
import { z } from 'zod'

/** The newest order when the feed started: its creation time as Medusa wrote it, and its id. Null for a store without orders then. */
export interface Boundary {
  time: string
  id: string
}

/**
 * Position in the Order feed (ADR 0021). `position` is the plugin's journal seq taken when the feed started (0 for an
 * empty journal); `boundary` the newest order then. While listing, `lastTime` is the keyset (the `created_at` of the
 * last order listed, null before the first page), `seen` the ids already dealt with at that millisecond, and `tie`
 * the offset into that millisecond when a whole page of orders shares it (null otherwise).
 */
export type OrdersCursor =
  | { phase: 'listing'; position: number; boundary: Boundary | null; lastTime: string | null; seen: string[]; tie: number | null }
  | { phase: 'journal'; position: number; boundary: Boundary | null }

const LISTING = 'l1'
const JOURNAL = 'e1'
const isoTime = z.iso.datetime({ offset: true })
const WHOLE = /^(0|[1-9]\d{0,14})$/

// Every field is URI-encoded, so neither `:` nor `,` appears inside one; an absent field is the empty string.
const field = (value: string | null) => (value === null ? '' : encodeURIComponent(value))
const number = (value: number | null) => (value === null ? '' : String(value))

/**
 * `l1:<position>:<boundary time>:<boundary id>:<last time>:<seen ids>:<tie offset>` while listing,
 * `e1:<position>:<boundary time>:<boundary id>` in the journal.
 */
export function encodeCursor(cursor: OrdersCursor): string {
  const boundary = [field(cursor.boundary?.time ?? null), field(cursor.boundary?.id ?? null)]
  if (cursor.phase === 'journal') return [JOURNAL, String(cursor.position), ...boundary].join(':')
  return [LISTING, String(cursor.position), ...boundary, field(cursor.lastTime), cursor.seen.map(encodeURIComponent).join(','), number(cursor.tie)].join(':')
}

// The core stores the cursor this connector wrote, so one it cannot read is a bug, not an expired position.
function unreadable(): PermanentError {
  return new PermanentError('Unreadable Medusa Order feed cursor')
}

function decodeField(text: string): string | null {
  if (text === '') return null
  try {
    return decodeURIComponent(text)
  } catch {
    throw unreadable()
  }
}

function whole(text: string): number {
  if (!WHOLE.test(text)) throw unreadable()
  return Number(text)
}

function time(value: string | null): string {
  if (value === null || !isoTime.safeParse(value).success) throw unreadable()
  return value
}

function boundaryOf(timeText: string, idText: string): Boundary | null {
  const [boundaryTime, id] = [decodeField(timeText), decodeField(idText)]
  if (boundaryTime === null && id === null) return null
  if (id === null) throw unreadable()
  return { time: time(boundaryTime), id }
}

export function decodeCursor(text: string): OrdersCursor {
  const [prefix, ...fields] = text.split(':')
  if (prefix === JOURNAL && fields.length === 3) {
    const [position, boundaryTime, boundaryId] = fields as [string, string, string]
    return { phase: 'journal', position: whole(position), boundary: boundaryOf(boundaryTime, boundaryId) }
  }
  if (prefix === LISTING && fields.length === 6) {
    const [position, boundaryTime, boundaryId, lastTime, seen, tie] = fields as [string, string, string, string, string, string]
    const boundary = boundaryOf(boundaryTime, boundaryId)
    // Listing needs a boundary: a store without orders at the start has nothing to list.
    if (boundary === null) throw unreadable()
    const last = decodeField(lastTime)
    const seenIds = seen === '' ? [] : seen.split(',').map((id) => decodeField(id) ?? '')
    if (seenIds.includes('') || (last === null && (seenIds.length > 0 || tie !== ''))) throw unreadable()
    return {
      phase: 'listing',
      position: whole(position),
      boundary,
      lastTime: last === null ? null : time(last),
      seen: seenIds,
      tie: tie === '' ? null : whole(tie),
    }
  }
  throw unreadable()
}

/** Milliseconds of an ISO time; the cursor and Medusa's answers carry milliseconds at most. */
export function millis(value: string): number {
  return Date.parse(value)
}

/**
 * Whether an order was placed after the boundary, by creation time and then id. The same rule in every place it is
 * asked, so an order is either after the boundary or not, whichever page sees it.
 */
export function isAfterBoundary(order: { created_at: string; id: string }, boundary: Boundary | null): boolean {
  if (boundary === null) return true
  const [orderTime, boundaryTime] = [millis(order.created_at), millis(boundary.time)]
  if (orderTime !== boundaryTime) return orderTime > boundaryTime
  return order.id > boundary.id
}
