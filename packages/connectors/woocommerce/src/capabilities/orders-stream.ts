import type { WooOrder } from '../api'

// Reading a list of order snapshots without ever skipping one.
//
// WooCommerce lists orders by a time of second resolution and then by id, and its date filters are strict (`>`), also
// to the second. A list is therefore followed by keyset: the request asks for everything after the second before the
// last entry dealt with, and what was dealt with already is dropped. Several orders may share a second, more of them
// than fit one page, so the position also carries a rank: how many entries of its second were dealt with. The
// request skips all but the last of those (`offset`), and that one must come back first, as the anchor: it proves
// that no entry before it left the list since, which would have moved an unread entry into the skipped part.

/** A place in a list: a time in whole seconds since the epoch, then the order id. */
export interface Position {
  second: number
  id: number
}

export function comparePositions(a: Position, b: Position): number {
  return a.second - b.second || a.id - b.id
}

export interface Entry {
  order: WooOrder
  /** The time the list is ordered by (creation or modification), and the order's id. */
  key: Position
}

export interface StreamPage {
  /** In the shop's order. */
  entries: Entry[]
  /** The shop's clock when it answered, null when it did not say. */
  shopTimeMs: number | null
}

export interface Run {
  /** The entries behind the position, in the shop's order, with none missing between the position and any of them. */
  fresh: Entry[]
  /** Every entry of the page `fresh` comes from, and how many entries of the list that page skipped. */
  page: Entry[]
  offset: number
  /** The list has nothing behind `page`. */
  exhausted: boolean
  /**
   * Set when no page could be trusted within the request budget (the list kept changing, or one second holds
   * several pages of entries dealt with): the rank to go on from. `fresh` is empty then.
   */
  resumeRank: number | null
  /** The shop's clock of every request made. */
  shopTimesMs: Array<number | null>
}

/** Requests per list and call. One is the rule; a second and third only while an anchor is being found again. */
export const MAX_RUN_REQUESTS = 3

/**
 * Reads the page behind `position` from a list. `read(offset)` asks the shop for one page of the entries after the
 * second before `position.second`, in the list's order, skipping `offset` of them. A page needs at least two entries
 * (`perPage` ≥ 2): the anchor and one more.
 */
export async function readRun(read: (offset: number) => Promise<StreamPage>, position: Position, rank: number, perPage: number): Promise<Run> {
  const shopTimesMs: Array<number | null> = []
  let offset = Math.max(0, rank - 1)
  for (let requests = 1; ; requests++) {
    const { entries, shopTimeMs } = await read(offset)
    shopTimesMs.push(shopTimeMs)
    const fresh = entries.filter((entry) => comparePositions(entry.key, position) > 0)
    const done = entries.length - fresh.length
    const full = entries.length >= perPage

    let next: number | null = null
    // No anchor: entries before the position left the list, so this page may start behind unread ones. Step back.
    if (offset > 0 && done === 0) next = Math.max(0, offset - (perPage - 1))
    // A whole page of entries dealt with: go on from its last one.
    else if (fresh.length === 0 && full) next = offset + done - 1

    if (next === null) return { fresh, page: entries, offset, exhausted: !full, resumeRank: null, shopTimesMs }
    if (requests >= MAX_RUN_REQUESTS) return { fresh: [], page: [], offset: next, exhausted: false, resumeRank: next === 0 ? 0 : next + 1, shopTimesMs }
    offset = next
  }
}

/** The rank of `to` in the run's list, when the feed moves from `from` to `to` (anywhere up to the run's last entry). */
export function rankAt(run: Run, from: Position, to: Position): number {
  if (run.resumeRank !== null) return run.resumeRank
  const counted = run.page.filter((entry) => entry.key.second === to.second && comparePositions(entry.key, to) <= 0).length
  // Only a page that began inside this second skipped entries of it.
  return (to.second === from.second ? run.offset : 0) + counted
}

export interface Merged {
  /** What may be reported now, in the order of their keys. */
  entries: Entry[]
  /** The position after them; `from` when there are none. */
  position: Position
  /** A list may hold more that can be read right away. */
  more: boolean
}

const END: Position = { second: Infinity, id: Infinity }

/**
 * Joins the runs of several lists that share one position (the live orders and the trash). Only entries stamped up
 * to `cutoffSecond` are taken: a later second may still get entries. And only up to the point every list is known
 * to be complete for, which for a list with more pages is its last settled entry read: behind that, another list's
 * entry could come before one that was not read yet, and moving the position past it would lose it.
 *
 * Which entries are settled is decided by their own stamps, not by where they stand in the page: an order saved
 * again while the shop was answering stands in its old place with a new stamp, and a shop on the old order storage
 * sorts by site time, which runs backwards for an hour when the clocks are set back.
 */
export function mergeRuns(runs: readonly Run[], from: Position, cutoffSecond: number): Merged {
  const parts = runs.map((run) => {
    const settled = run.fresh.filter((entry) => entry.key.second <= cutoffSecond)
    const last = settled.reduce((max, entry) => (comparePositions(entry.key, max) > 0 ? entry.key : max), from)
    return {
      settled,
      // A list read to its end has nothing unread to protect. One with more pages is known up to its last settled
      // entry: every unread entry stands behind the page, and so behind every settled entry of it.
      limit: run.resumeRank === null && run.exhausted ? END : last,
      more: !run.exhausted && settled.length === run.fresh.length,
    }
  })
  const bound = parts.reduce((min, part) => (comparePositions(part.limit, min) < 0 ? part.limit : min), END)
  const entries = parts
    .flatMap((part) => part.settled.filter((entry) => comparePositions(entry.key, bound) <= 0))
    .sort((a, b) => comparePositions(a.key, b.key))
  return {
    entries,
    position: entries.reduce((max, entry) => (comparePositions(entry.key, max) > 0 ? entry.key : max), from),
    more: parts.some((part) => part.more),
  }
}
