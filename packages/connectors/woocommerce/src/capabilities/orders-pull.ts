import { PermanentError, type Order, type OrderUpdate, type PullResult } from '@hanza/connector-sdk'
import { WOO_ORDER_FIELDS, wooOrderIdsSchema, wooOrdersSchema, type WooOrder } from '../api'
import { request, type Query } from '../client'
import { isOpen, mapOrder, mapOrderUpdate } from '../mapping/order'
import { isDraftStatus, OPEN_STATUSES } from '../mapping/status'
import type { WooCommerceContext } from '../settings'
import { changesStart, encodeCursor, listingStart, parseCursor, type ChangesCursor, type ListingCursor } from './orders-cursor'
import { readParentSkus, withOwnSkus } from './orders-line-skus'
import { comparePositions, mergeRuns, rankAt, readRun, type Entry, type Position, type Run, type StreamPage } from './orders-stream'

export interface OrdersPullOptions {
  /** Orders asked for per request, 1 to 100. */
  pageSize: number
  /** How far behind the shop's clock the changes are read, in seconds. */
  holdBackSeconds: number
  /** Hanza's clock in milliseconds, used only for a response without a `Date` header. Default `Date.now`. */
  now?: () => number
}

/**
 * Added to the hold-back when the shop sends no `Date` header and Hanza's own clock has to stand in for the shop's.
 * A Hanza clock that runs ahead would take a second for over while the shop is still in it, and a second save in
 * that second would hide behind the cursor; two minutes covers any server that keeps time at all.
 */
export const CLOCK_SKEW_ALLOWANCE_SECONDS = 120

/**
 * The shop's clock in whole seconds, from the earliest answer of the call: the most careful one. An answer without
 * a `Date` header counts as Hanza's clock less the skew allowance, and the call says so once.
 */
function shopSecondOf(ctx: WooCommerceContext, shopTimesMs: ReadonlyArray<number | null>, now: () => number): number {
  if (shopTimesMs.includes(null)) {
    ctx.log(`WooCommerce sent no Date header: Hanza's own clock is used, ${CLOCK_SKEW_ALLOWANCE_SECONDS} s further behind`)
  }
  return Math.floor(Math.min(...shopTimesMs.map((time) => time ?? now() - CLOCK_SKEW_ALLOWANCE_SECONDS * 1000)) / 1000)
}

type Feed = PullResult<Order | OrderUpdate>

const BEFORE_EVERY_ORDER: Position = { second: -Infinity, id: 0 }

/**
 * A date filter of the orders list: UTC in whole seconds with a literal `Z`, and no `dates_are_gmt`. WooCommerce
 * reads a value with a fraction (`toISOString()`) as site time, and shifts a `Z` value sent with
 * `dates_are_gmt=true` by the site's offset; either is wrong by an hour or two, in silence.
 */
export function dateFilter(second: number): string {
  return new Date(second * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** A `_gmt` field of an order as whole seconds since the epoch; negative for a date before 1970, which the cursor carries too. */
function secondOf(gmt: string, orderId: number): number {
  const time = Date.parse(`${gmt}Z`)
  if (Number.isNaN(time)) throw new PermanentError(`Unexpected orders response from the shop: order ${orderId} has a date that is not one`)
  return time / 1000
}

type OrderList = 'created' | 'modified'

async function readOrders(ctx: WooCommerceContext, list: OrderList, query: Query): Promise<StreamPage> {
  const { data, shopTimeMs } = await request(ctx, { path: 'orders', query: { ...query, order: 'asc', _fields: WOO_ORDER_FIELDS }, schema: wooOrdersSchema, what: 'orders' })
  const entries = data.map((order) => ({
    order,
    key: { second: secondOf(list === 'created' ? order.date_created_gmt : order.date_modified_gmt, order.id), id: order.id },
  }))
  return { entries, shopTimeMs }
}

/** `offset=0` is left out, so the usual request is the plain one. */
const skip = (offset: number) => (offset > 0 ? offset : undefined)

// The anchor and at least one entry behind it (`readRun`).
const perPageOf = (options: OrdersPullOptions) => Math.max(2, options.pageSize)

/**
 * Rule 1. Where the feed starts: the shop's clock less the hold-back first, the highest order id second. An order
 * placed between the two is either at most the boundary and listed, or stamped after the start and read with the
 * changes. The trash counts for the boundary: an order from before the Connection that is restored from it later
 * must not pass for one placed after.
 */
async function start(ctx: WooCommerceContext, options: OrdersPullOptions, now: () => number): Promise<Feed> {
  const newest = (status: string) =>
    request(ctx, { path: 'orders', query: { status, orderby: 'id', order: 'desc', per_page: 1, _fields: ['id'] }, schema: wooOrderIdsSchema, what: 'orders' })
  const live = await newest('any')
  const trashed = await newest('trash')
  const shopSecond = shopSecondOf(ctx, [live.shopTimeMs], now)
  const boundary = Math.max(0, ...[...live.data, ...trashed.data].map((order) => order.id))
  const cursor = listingStart(Math.max(0, shopSecond - options.holdBackSeconds), boundary)
  // Nothing is reported yet; the engine goes on with the listing straight away.
  return { items: [], nextCursor: encodeCursor(cursor), hasMore: true }
}

interface Report {
  entry: Entry
  /** A full Order when the order is open or was placed after the boundary; else only its facts. */
  full: boolean
}

/** Rule 4, applied to one page: each entry as a full Order or an Order update, in the page's order. */
async function report(ctx: WooCommerceContext, reports: readonly Report[]): Promise<Array<Order | OrderUpdate>> {
  const parentSkus = await readParentSkus(ctx, reports.filter(({ full }) => full).map(({ entry }) => entry.order))
  const items: Array<Order | OrderUpdate> = []
  for (const { entry, full } of reports) {
    const { order } = entry
    if (!full) {
      items.push(mapOrderUpdate(order))
      continue
    }
    const mapped = mapOrder(withOwnSkus(order, parentSkus))
    if (mapped.fits) items.push(mapped.order)
    // Closed: its facts still matter to an Order imported earlier, and an update needs nothing the model lacks.
    else if (!isOpen(order)) items.push(mapOrderUpdate(order))
    // Paths only: the values are Buyer data.
    else ctx.log('WooCommerce order skipped: it does not fit the canonical Order', { orderId: order.id, problems: mapped.problems })
  }
  return items
}

/**
 * Rule 2. The orders open now, by creation time and id. An order that closes between two pages leaves the list
 * without moving the others past the position; one that is closed already though its status is open (completed
 * once, then reopened) is not imported.
 *
 * Only WooCommerce's own three open statuses are listed. An order waiting in a status a plugin added (`packing`)
 * is not: the connector cannot tell such a status from one a plugin uses for orders that are done (`delivered`),
 * and listing those would reserve Stock for every order a shop ever shipped. It is imported when it next changes
 * while still open; if its next change is its completion, it never is, and its units stay in Hanza's Stock.
 */
async function list(ctx: WooCommerceContext, cursor: ListingCursor, input: string, options: OrdersPullOptions): Promise<Feed> {
  const perPage = perPageOf(options)
  // No order has id 0, so that id says nothing was listed yet: the listing then starts before every date there is,
  // also before 1970, where a shop's odd order may be.
  const started = cursor.at.id > 0
  const at = started ? cursor.at : BEFORE_EVERY_ORDER
  const run = await readRun(
    (offset) =>
      readOrders(ctx, 'created', {
        status: OPEN_STATUSES,
        orderby: 'date',
        per_page: perPage,
        // Strict and to the second: the position's own second is read again, and what was listed is dropped.
        after: started ? dateFilter(at.second - 1) : undefined,
        offset: skip(offset),
      }),
    at,
    cursor.rank,
    perPage,
  )
  const position = run.fresh.reduce((max, entry) => (comparePositions(entry.key, max) > 0 ? entry.key : max), at)
  const items = await report(ctx, run.fresh.filter((entry) => isOpen(entry.order)).map((entry) => ({ entry, full: true })))
  // The listing is over: the changes begin at the start taken before it, so nothing placed or changed meanwhile is lost.
  const next = run.exhausted ? changesStart(cursor.start, cursor.boundary) : { ...cursor, at: position.id > 0 ? position : cursor.at, rank: rankAt(run, at, position) }
  const nextCursor = encodeCursor(next)
  // The cursor always moves: a page that is not the last one has an entry behind the position, and a run that found
  // no page to trust leaves another rank (`readRun` makes an odd number of steps of one size). Should that ever not
  // hold, the call ends the run instead of breaking the paging contract, and the next run reads the list again.
  return { items, nextCursor, hasMore: nextCursor !== input }
}

/**
 * Rule 3. Every order changed since the position, the trash included (`status=any` leaves it out and cannot be
 * combined with it, hence two lists), up to the hold-back: `date_modified` is stamped before the row is written and
 * has second resolution, so a second is read only once it is over and its late writes have landed.
 */
async function changes(ctx: WooCommerceContext, cursor: ChangesCursor, input: string, options: OrdersPullOptions, now: () => number): Promise<Feed> {
  const perPage = perPageOf(options)
  const { at, boundary } = cursor
  const modifiedAfter = dateFilter(at.second - 1)
  const read = (status: string, rank: number): Promise<Run> =>
    readRun((offset) => readOrders(ctx, 'modified', { status, orderby: 'modified', per_page: perPage, modified_after: modifiedAfter, offset: skip(offset) }), at, rank, perPage)
  const live = await read('any', cursor.ranks.live)
  const trash = await read('trash', cursor.ranks.trash)

  const shopSecond = shopSecondOf(ctx, [...live.shopTimesMs, ...trash.shopTimesMs], now)
  // The newest second that ended at least the hold-back ago.
  const merged = mergeRuns([live, trash], at, shopSecond - options.holdBackSeconds - 1)

  const nextCursor = encodeCursor({ ...cursor, at: merged.position, ranks: { live: rankAt(live, at, merged.position), trash: rankAt(trash, at, merged.position) } })
  const hasMore = merged.more && nextCursor !== input
  if (merged.entries.length === 0 && !hasMore) return { items: [], nextCursor: input, hasMore: false }

  const items = await report(
    ctx,
    merged.entries
      .filter((entry) => !isDraftStatus(entry.order.status))
      .map((entry) => ({ entry, full: entry.order.id > boundary || isOpen(entry.order) })),
  )
  return { items, nextCursor, hasMore }
}

/**
 * `orders.pull`: the open orders when the feed starts, then every change, from order snapshots (WooCommerce has no
 * journal). Cursor null takes the start, `l1:` lists, `c1:` follows the changes; see `orders-cursor.ts`.
 */
export async function pullOrders(ctx: WooCommerceContext, cursor: string | null, options: OrdersPullOptions): Promise<Feed> {
  const now = options.now ?? Date.now
  if (cursor === null) return start(ctx, options, now)
  const parsed = parseCursor(cursor)
  return parsed.phase === 'listing' ? list(ctx, parsed, cursor, options) : changes(ctx, parsed, cursor, options, now)
}
