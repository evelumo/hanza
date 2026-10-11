import type { WooOrder } from '../api'

// Reading a list of order snapshots without ever skipping one.
//
// WooCommerce lists orders by a time of second resolution, and its date filters are strict (`>`), also to the second.
// A list is therefore followed by keyset: the request asks for everything after the second before the last entry
// dealt with, and what was dealt with already is dropped. Several orders may share a second, so the position also
// carries a rank: how many entries of its second were dealt with. The request skips all but one of those
// (`offset`), and an entry dealt with must come back first, as the anchor: it proves that the skipped part held
// nothing unread, which it would if an entry before the position left the list since.
//
// Whether the orders of ONE second come in a known order depends on the list:
//
// - Ordered to the end (by creation time then id on every version; by id; by modification time then id from
//   WooCommerce 10.4.0): the position may rest anywhere, also inside a second a page ended in. `readRun` and
//   `mergeRuns` are all such a list needs.
// - By modification time before WooCommerce 10.4.0: no tie-break. The orders of a second come in whatever order
//   the database finds them, another one on every request, also on two `offset` pages of the same list. Only the
//   order of the SECONDS can be trusted. So such a list is taken second by second (`mergeSeconds`): the position
//   rests only at the end of a second that was read whole, where every entry of it is dealt with whatever order
//   they come in, and never inside the second a page end cut through. A second that fills a page alone is read
//   through another list of that one second, ordered by id.

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
 * In the order of their keys, each key once. The lists are meant to hold different orders, but some versions put an
 * order in two of them (on WooCommerce 10.3.8 with HPOS `status=any` lists the trash as well): the same snapshot
 * then comes twice, and is reported once.
 */
function inOrder(entries: Entry[]): Entry[] {
  const sorted = [...entries].sort((a, b) => comparePositions(a.key, b.key))
  return sorted.filter((entry, index) => index === 0 || comparePositions(entry.key, sorted[index - 1]!.key) !== 0)
}

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
  const entries = inOrder(parts.flatMap((part) => part.settled.filter((entry) => comparePositions(entry.key, bound) <= 0)))
  return {
    entries,
    position: entries.reduce((max, entry) => (comparePositions(entry.key, max) > 0 ? entry.key : max), from),
    more: parts.some((part) => part.more),
  }
}

export interface MergedSeconds extends Merged {
  /**
   * Set when nothing could be taken because a page ended inside the first second there is to read: that second.
   * It has to be read from a list of its own, ordered by id.
   */
  drain: number | null
}

/**
 * `mergeRuns` for lists whose order inside a second is not known (the changes before WooCommerce 10.4.0): whole
 * seconds only. Of a list with more pages, the last settled second of the page is left out, since the page may have
 * ended inside it and the unread rest of it could stand anywhere in the next answer; every second before it is in
 * the page whole, because the seconds themselves are in order. The position then rests on the last second taken,
 * which is whole in every list.
 *
 * Where that leaves nothing to take though settled entries are waiting, the first of their seconds fills a page
 * alone (`drain`). Not when a list with more pages shows no settled entry at all: what stands behind its page
 * is then unknown, and the call waits.
 */
export function mergeSeconds(runs: readonly Run[], from: Position, cutoffSecond: number): MergedSeconds {
  const parts = runs.map((run) => {
    const settled = run.fresh.filter((entry) => entry.key.second <= cutoffSecond)
    const whole = run.resumeRank === null && run.exhausted
    const lastSecond = settled.reduce((max, entry) => Math.max(max, entry.key.second), -Infinity)
    return { settled, whole, through: whole ? Infinity : lastSecond - 1 }
  })
  const through = Math.min(cutoffSecond, ...parts.map((part) => part.through))
  const entries = inOrder(parts.flatMap((part) => part.settled.filter((entry) => entry.key.second <= through)))
  if (entries.length > 0) {
    const position = entries.reduce((max, entry) => (comparePositions(entry.key, max) > 0 ? entry.key : max), from)
    return { entries, position, more: parts.some((part) => !part.whole), drain: null }
  }
  const waiting = parts.flatMap((part) => part.settled)
  const unknown = parts.some((part) => !part.whole && part.settled.length === 0)
  const drain = waiting.length > 0 && !unknown ? Math.min(...waiting.map((entry) => entry.key.second)) : null
  // A list that found no page to trust has another rank to go on from.
  return { entries: [], position: from, more: runs.some((run) => run.resumeRank !== null), drain }
}
