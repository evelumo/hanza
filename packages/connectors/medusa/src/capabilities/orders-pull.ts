import type { Order, OrderUpdate, PullResult } from '@hanza/connector-sdk'
import { z } from 'zod'
import { boundaryPageSchema, journalPageSchema, ORDER_FIELDS, ordersPageSchema, type HanzaStatus, type MedusaOrder } from '../api'
import { request, type Query } from '../client'
import { mapOrder, mapOrderUpdate } from '../mapping/order'
import { isOpen, LISTED_ORDER_STATUSES, type OrderRules } from '../mapping/status'
import { readPluginAnswer, readStatus } from '../plugin'
import type { MedusaContext } from '../settings'
import { decodeCursor, encodeCursor, isAfterBoundary, millis, type Boundary, type OrdersCursor } from './orders-cursor'

type FeedItem = Order | OrderUpdate
type ListingCursor = Extract<OrdersCursor, { phase: 'listing' }>
type JournalCursor = Extract<OrdersCursor, { phase: 'journal' }>

export interface OrdersPullOptions {
  /** Orders per listing request, and per re-read of the orders a journal page names (at most 100). */
  pageSize: number
  /** Journal entries per request (the plugin's maximum is 500). */
  journalPageSize: number
}

/** What a page of the feed needs from the plugin's status. */
interface FeedSettings {
  rules: OrderRules
  /** Empty: every sales channel. */
  salesChannelIds: string[]
}

function feedSettings(status: HanzaStatus): FeedSettings {
  return { rules: status.settings, salesChannelIds: status.settings.sales_channel_ids }
}

/** One millisecond past `time`: Medusa keeps microseconds and answers in milliseconds, so a bound on a time it sent is open. */
function justAfter(time: string): string {
  return new Date(millis(time) + 1).toISOString()
}

/** Whether the feed reports this order at all: never a draft, and only in the sales channels the plugin's settings name. */
function isReported(order: MedusaOrder, settings: FeedSettings): boolean {
  if (order.is_draft_order === true || order.status === 'draft') return false
  return settings.salesChannelIds.length === 0 || settings.salesChannelIds.includes(order.sales_channel_id ?? '')
}

/** The order as a full Order, or nothing when it does not fit the canonical Order (logged with its id and the field paths, never values). */
function fullOrder(ctx: MedusaContext, order: MedusaOrder, rules: OrderRules): Order | null {
  const mapped = mapOrder(order, rules)
  if (mapped.fits) return mapped.order
  ctx.log('Medusa order skipped: it does not fit the canonical Order', { orderId: mapped.externalId, fields: mapped.problems })
  return null
}

/**
 * What one order becomes on a page: a full Order when `full` and it fits; an Order update when it is closed (also one
 * that does not fit); nothing for an open one that does not fit.
 */
function itemFor(ctx: MedusaContext, order: MedusaOrder, rules: OrderRules, full: boolean): FeedItem | null {
  if (full || isOpen(order, rules)) {
    const mapped = fullOrder(ctx, order, rules)
    if (mapped !== null) return mapped
    return isOpen(order, rules) ? null : mapOrderUpdate(order, rules)
  }
  return mapOrderUpdate(order, rules)
}

/** Full Orders first, then updates: a full Order comes before any update of the same order on a page. */
function fullFirst(items: Array<FeedItem | null>): FeedItem[] {
  const present = items.filter((item): item is FeedItem => item !== null)
  return [...present.filter((item) => !('kind' in item)), ...present.filter((item) => 'kind' in item)]
}

function listingQuery(settings: FeedSettings, pageSize: number, filters: Query): Query {
  return [
    ['status', [...LISTED_ORDER_STATUSES]],
    ...filters,
    ...(settings.salesChannelIds.length > 0 ? ([['sales_channel_id', settings.salesChannelIds]] as const) : []),
    ['limit', pageSize],
    ['fields', ORDER_FIELDS],
  ]
}

/**
 * One page of the orders open at the start, placed up to the boundary's millisecond, by keyset on `created_at` (Medusa
 * sorts on one field only, so the ids already dealt with at the last millisecond travel in the cursor). Open orders go
 * in full, closed ones as updates. A full page that does not move past its millisecond (a bulk import made in one
 * transaction stamps every order alike) is read again by id within that millisecond, with overlapping pages.
 */
async function listingPage(ctx: MedusaContext, cursor: ListingCursor, settings: FeedSettings, options: OrdersPullOptions): Promise<PullResult<FeedItem>> {
  const boundary = cursor.boundary!
  const inTie = cursor.tie !== null && cursor.lastTime !== null
  const filters: Query = inTie
    ? [
        ['created_at[$gte]', cursor.lastTime!],
        ['created_at[$lt]', justAfter(cursor.lastTime!)],
        ['order', 'id'],
        ['offset', cursor.tie!],
      ]
    : [
        ...(cursor.lastTime === null ? [] : ([['created_at[$gte]', cursor.lastTime]] as const)),
        ['created_at[$lt]', justAfter(boundary.time)],
        ['order', 'created_at'],
      ]
  const { orders } = await request(ctx, { path: 'orders', query: listingQuery(settings, options.pageSize, filters), schema: ordersPageSchema, what: 'order list' })

  const seen = new Set(cursor.seen)
  const fresh = orders.filter((order) => !seen.has(order.id))
  const items = fullFirst(fresh.filter((order) => isReported(order, settings)).map((order) => itemFor(ctx, order, settings.rules, false)))
  const full = orders.length >= options.pageSize
  const journal: JournalCursor = { phase: 'journal', position: cursor.position, boundary }

  if (inTie) {
    const nextSeen = [...cursor.seen, ...fresh.map((order) => order.id)]
    // The millisecond is read to its end: go on after it with the keyset.
    if (!full) {
      const next: ListingCursor = { ...cursor, lastTime: justAfter(cursor.lastTime!), seen: [], tie: null }
      return { items, nextCursor: encodeCursor(millis(next.lastTime!) > millis(boundary.time) ? journal : next), hasMore: true }
    }
    // Overlap half a page: an order of that millisecond that closes between two requests moves the others up.
    const step = Math.max(1, orders.length - Math.floor(options.pageSize / 2))
    return { items, nextCursor: encodeCursor({ ...cursor, seen: nextSeen, tie: cursor.tie! + step }), hasMore: true }
  }

  if (!full) return { items, nextCursor: encodeCursor(journal), hasMore: true }
  let lastTime = orders[0]!.created_at
  for (const order of orders) if (millis(order.created_at) > millis(lastTime)) lastTime = order.created_at
  const atLast = orders.filter((order) => millis(order.created_at) === millis(lastTime)).map((order) => order.id)
  const sameMillisecond = cursor.lastTime !== null && millis(lastTime) === millis(cursor.lastTime)
  if (sameMillisecond) {
    // A whole page in the last millisecond: no keyset moves past it.
    return { items, nextCursor: encodeCursor({ ...cursor, seen: [...new Set([...cursor.seen, ...atLast])], tie: 0 }), hasMore: true }
  }
  return { items, nextCursor: encodeCursor({ ...cursor, lastTime, seen: atLast, tie: null }), hasMore: true }
}

/** The orders a journal page names, read again in batches; an id Medusa no longer lists is logged and left out. */
async function readOrders(ctx: MedusaContext, ids: string[], pageSize: number): Promise<MedusaOrder[]> {
  const found: MedusaOrder[] = []
  for (let start = 0; start < ids.length; start += pageSize) {
    const batch = ids.slice(start, start + pageSize)
    const { orders } = await request(ctx, {
      path: 'orders',
      query: [
        ['id', batch],
        ['limit', batch.length],
        ['fields', ORDER_FIELDS],
      ],
      schema: ordersPageSchema,
      what: 'order list',
    })
    const byId = new Map(orders.map((order) => [order.id, order]))
    for (const id of batch) {
      const order = byId.get(id)
      if (order === undefined) ctx.log('Medusa order named by the journal was not found; left out', { orderId: id })
      else found.push(order)
    }
  }
  return found
}

/** One page of the plugin's order journal from the cursor's position: each order it names once, read as it is now. */
async function journalPage(
  ctx: MedusaContext,
  cursor: JournalCursor,
  cursorText: string,
  settings: FeedSettings,
  options: OrdersPullOptions,
): Promise<PullResult<FeedItem>> {
  const raw = await request(ctx, {
    path: 'hanza/journal',
    query: [
      ['after', cursor.position],
      ['limit', options.journalPageSize],
    ],
    schema: z.unknown(),
    what: 'order journal',
  })
  const { entries } = readPluginAnswer(raw, journalPageSchema, 'order journal')
  if (entries.length === 0) return { items: [], nextCursor: cursorText, hasMore: false }

  const ids = [...new Set(entries.map((entry) => entry.order_id))]
  const orders = await readOrders(ctx, ids, options.pageSize)
  // Full Orders only after the boundary: an order placed before it was either listed, or closed before the feed started.
  const items = fullFirst(
    orders.filter((order) => isReported(order, settings)).map((order) => (isAfterBoundary(order, cursor.boundary) ? itemFor(ctx, order, settings.rules, true) : mapOrderUpdate(order, settings.rules))),
  )
  const last = entries.reduce((max, entry) => Math.max(max, entry.seq), cursor.position)
  return {
    items,
    nextCursor: encodeCursor({ phase: 'journal', position: last, boundary: cursor.boundary }),
    hasMore: entries.length >= options.journalPageSize,
  }
}

/** The newest order of the store, or null for a store without orders. */
async function readBoundary(ctx: MedusaContext): Promise<Boundary | null> {
  const { orders } = await request(ctx, {
    path: 'orders',
    query: [
      ['order', '-created_at'],
      ['limit', 1],
      ['fields', 'id,created_at'],
    ],
    schema: boundaryPageSchema,
    what: 'newest order',
  })
  const newest = orders[0]
  return newest === undefined ? null : { time: newest.created_at, id: newest.id }
}

/**
 * The Order feed (ADR 0021). Every call reads the plugin's status first (the settings decide what is reported). Cursor
 * null takes the journal position (`journal.newest_seq` of that status) first and the boundary (the newest order)
 * second, then lists the orders open now placed up to the boundary, then follows the journal from that position.
 * Both stay in every cursor: `l1:` while listing, `e1:` in the journal.
 */
export async function pullOrders(ctx: MedusaContext, cursorText: string | null, options: OrdersPullOptions): Promise<PullResult<FeedItem>> {
  const cursor = cursorText === null ? null : decodeCursor(cursorText)
  const status = await readStatus(ctx)
  const settings = feedSettings(status)
  if (cursor === null) {
    const position = status.journal.newest_seq ?? 0
    const boundary = await readBoundary(ctx)
    if (boundary === null) {
      const journal: JournalCursor = { phase: 'journal', position, boundary: null }
      return journalPage(ctx, journal, encodeCursor(journal), settings, options)
    }
    return listingPage(ctx, { phase: 'listing', position, boundary, lastTime: null, seen: [], tie: null }, settings, options)
  }
  return cursor.phase === 'listing' ? listingPage(ctx, cursor, settings, options) : journalPage(ctx, cursor, cursorText!, settings, options)
}
