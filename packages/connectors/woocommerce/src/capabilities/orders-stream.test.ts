import { describe, expect, it } from 'vitest'
import type { WooOrder } from '../api'
import { comparePositions, MAX_RUN_REQUESTS, mergeRuns, rankAt, readRun, type Entry, type Position, type Run } from './orders-stream'

const entry = (second: number, id: number): Entry => ({ key: { second, id }, order: { id } as WooOrder })
const keys = (entries: readonly Entry[]) => entries.map(({ key }) => `${key.second}/${key.id}`)

/** A list as the shop serves it: ordered by time then id, filtered strictly after a second, paged by offset. */
class List {
  readonly offsets: number[] = []
  constructor(
    public entries: Entry[],
    private readonly perPage: number,
  ) {}

  reader(position: Position) {
    return async (offset: number) => {
      this.offsets.push(offset)
      const behind = this.entries.filter(({ key }) => key.second > position.second - 1).sort((a, b) => comparePositions(a.key, b.key))
      return { entries: behind.slice(offset, offset + this.perPage), shopTimeMs: 0 }
    }
  }

  remove(...ids: number[]) {
    this.entries = this.entries.filter(({ key }) => !ids.includes(key.id))
  }
}

/** Follows a list to its end the way the feed does: position and rank from one call to the next. */
async function follow(list: List, perPage: number, between: (call: number) => void = () => {}) {
  const seen: Entry[] = []
  let position: Position = { second: 0, id: 0 }
  let rank = 0
  for (let call = 1; call <= 500; call++) {
    const run = await readRun(list.reader(position), position, rank, perPage)
    seen.push(...run.fresh)
    const next = run.fresh.reduce((max, { key }) => (comparePositions(key, max) > 0 ? key : max), position)
    rank = rankAt(run, position, next)
    position = next
    if (run.exhausted) return { seen, calls: call }
    between(call)
  }
  throw new Error('the list never ended')
}

describe('readRun', () => {
  it('reads the position\'s second again and drops what was dealt with', async () => {
    const list = new List([entry(10, 3), entry(11, 4), entry(12, 5), entry(13, 6)], 3)
    const position = { second: 10, id: 3 }
    const run = await readRun(list.reader(position), position, 1, 3)
    expect(keys(run.fresh)).toEqual(['11/4', '12/5'])
    expect(run).toMatchObject({ offset: 0, exhausted: false, resumeRank: null })
    expect(list.offsets).toEqual([0])
  })

  it('says the list is exhausted when the page is not full', async () => {
    const list = new List([entry(10, 3), entry(11, 4)], 3)
    const position = { second: 10, id: 3 }
    expect(await readRun(list.reader(position), position, 1, 3)).toMatchObject({ exhausted: true, fresh: [entry(11, 4)] })
    const end = { second: 11, id: 4 }
    expect(await readRun(list.reader(end), end, 1, 3)).toMatchObject({ exhausted: true, fresh: [] })
  })

  it('reads an empty list', async () => {
    const position = { second: 0, id: 0 }
    expect(await readRun(new List([], 3).reader(position), position, 0, 3)).toMatchObject({ fresh: [], page: [], exhausted: true, resumeRank: null })
  })

  it('pages through more entries of one second than fit a page, by rank, each of them once', async () => {
    const list = new List([1, 2, 3, 4, 5, 6, 7].map((id) => entry(10, id)), 3)
    const { seen, calls } = await follow(list, 3)
    expect(keys(seen)).toEqual(['10/1', '10/2', '10/3', '10/4', '10/5', '10/6', '10/7'])
    // The last entry dealt with is read again each time, as the anchor.
    expect(list.offsets).toEqual([0, 2, 4, 6])
    expect(calls).toBe(4)
  })

  it('steps back when the anchor is gone: an entry before it left the list, so the page may start behind unread ones', async () => {
    const list = new List([1, 2, 3, 4, 5, 6, 7].map((id) => entry(10, id)), 3)
    const position = { second: 10, id: 3 }
    // 1 left the list: skipping two entries now starts at 4, and skipping three, as a plain offset would, loses 4.
    list.remove(1)
    const run = await readRun(list.reader(position), position, 3, 3)
    expect(list.offsets).toEqual([2, 0])
    expect(keys(run.fresh)).toEqual(['10/4'])
    // The rank is right again for the next call.
    expect(rankAt(run, position, { second: 10, id: 4 })).toBe(3)
  })

  it('needs no anchor at the start of a second: nothing can hide before the first entry', async () => {
    const list = new List([entry(10, 3), entry(11, 4), entry(11, 5)], 3)
    const position = { second: 10, id: 3 }
    // The last entry dealt with was changed again and left its place.
    list.remove(3)
    const run = await readRun(list.reader(position), position, 1, 3)
    expect(keys(run.fresh)).toEqual(['11/4', '11/5'])
    expect(list.offsets).toEqual([0])
  })

  it('moves on over a whole page of entries dealt with', async () => {
    const list = new List([1, 2, 3, 4, 5, 6, 7].map((id) => entry(10, id)), 3)
    const position = { second: 10, id: 5 }
    // A rank that is too low, as after stepping back.
    const run = await readRun(list.reader(position), position, 0, 3)
    expect(list.offsets).toEqual([0, 2, 4])
    expect(keys(run.fresh)).toEqual(['10/6', '10/7'])
  })

  it('makes a bounded number of requests, and says where to go on', async () => {
    const list = new List(Array.from({ length: 40 }, (_, index) => entry(10, index + 1)), 3)
    const position = { second: 10, id: 30 }
    const run = await readRun(list.reader(position), position, 0, 3)
    expect(list.offsets).toHaveLength(MAX_RUN_REQUESTS)
    expect(run).toMatchObject({ fresh: [], exhausted: false, resumeRank: 7 })
    // Going on from there reaches the entries behind the position without losing one.
    let rank = run.resumeRank!
    const seen: Entry[] = []
    for (let call = 0; call < 20 && seen.length === 0; call++) {
      const next = await readRun(list.reader(position), position, rank, 3)
      seen.push(...next.fresh)
      rank = rankAt(next, position, position)
    }
    expect(keys(seen)[0]).toBe('10/31')
  })

  it('reports the shop\'s clock of every request it made', async () => {
    const times = [1000, 2000]
    const position = { second: 10, id: 3 }
    // The first page has no anchor; the second, one entry back, has.
    const run = await readRun(async (offset) => ({ entries: offset === 3 ? [entry(10, 3), entry(10, 4)] : [], shopTimeMs: times.shift() ?? null }), position, 5, 2)
    expect(run.shopTimesMs).toEqual([1000, 2000])
    expect(run.fresh).toEqual([entry(10, 4)])
  })

  // A small generator with a fixed seed: the same lists on every run.
  function random(seed: number) {
    let state = seed
    return (below: number) => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
      return Math.floor((state / 2_147_483_648) * below)
    }
  }

  it('never skips an entry that stays in the list, whatever leaves the list between the calls', async () => {
    for (let seed = 1; seed <= 400; seed++) {
      const pick = random(seed)
      const perPage = 2 + pick(4)
      // Few seconds, many entries: most pages lie inside one second.
      const all = Array.from({ length: 10 + pick(40) }, (_, index) => entry(10 + pick(4), index + 1))
      const list = new List([...all], perPage)
      const removed = new Set<number>()
      const { seen } = await follow(list, perPage, () => {
        for (let count = pick(3); count > 0 && list.entries.length > 0; count--) {
          const gone = list.entries[pick(list.entries.length)]!.key.id
          removed.add(gone)
          list.remove(gone)
        }
      })
      const seenIds = seen.map(({ key }) => key.id)
      expect(new Set(seenIds).size, `seed ${seed}: an entry was reported twice`).toBe(seenIds.length)
      const missed = all.filter(({ key }) => !removed.has(key.id) && !seenIds.includes(key.id))
      expect(keys(missed), `seed ${seed}: entries that stayed in the list were never read`).toEqual([])
      // In the list's order.
      expect(keys(seen)).toEqual(keys([...seen].sort((a, b) => comparePositions(a.key, b.key))))
    }
  })
})

describe('rankAt', () => {
  const run = (overrides: Partial<Run>): Run => ({ fresh: [], page: [], offset: 0, exhausted: true, resumeRank: null, shopTimesMs: [], ...overrides })

  it('counts the entries of the new position\'s second up to it', () => {
    const page = [entry(10, 3), entry(11, 4), entry(11, 5), entry(11, 6), entry(12, 7)]
    const from = { second: 10, id: 3 }
    expect(rankAt(run({ page }), from, { second: 11, id: 5 })).toBe(2)
    expect(rankAt(run({ page }), from, { second: 12, id: 7 })).toBe(1)
  })

  it('adds what the page skipped while the position stays in its second', () => {
    const page = [entry(10, 5), entry(10, 6), entry(10, 7)]
    const from = { second: 10, id: 5 }
    expect(rankAt(run({ page, offset: 4 }), from, { second: 10, id: 7 })).toBe(7)
    // Nothing reported: the rank the page itself shows.
    expect(rankAt(run({ page, offset: 4 }), from, from)).toBe(5)
  })

  it('is 0 at a position no entry of the page is at', () => {
    expect(rankAt(run({ page: [entry(12, 9)] }), { second: 10, id: 0 }, { second: 10, id: 0 })).toBe(0)
  })

  it('is the rank to go on from when the run found no page to trust', () => {
    expect(rankAt(run({ resumeRank: 9, exhausted: false }), { second: 10, id: 5 }, { second: 10, id: 5 })).toBe(9)
  })
})

describe('mergeRuns', () => {
  const from = { second: 10, id: 0 }
  const run = (fresh: Entry[], overrides: Partial<Run> = {}): Run => ({ fresh, page: fresh, offset: 0, exhausted: true, resumeRank: null, shopTimesMs: [], ...overrides })

  it('joins two lists by time, then id', () => {
    const merged = mergeRuns([run([entry(11, 4), entry(13, 2), entry(13, 9)]), run([entry(12, 7), entry(13, 5)])], from, 100)
    expect(keys(merged.entries)).toEqual(['11/4', '12/7', '13/2', '13/5', '13/9'])
    expect(merged.position).toEqual({ second: 13, id: 9 })
    expect(merged.more).toBe(false)
  })

  it('takes nothing stamped after the cut-off, and stays where the last entry taken was', () => {
    const merged = mergeRuns([run([entry(11, 4), entry(20, 5), entry(21, 6)]), run([entry(12, 7), entry(21, 8)])], from, 20)
    expect(keys(merged.entries)).toEqual(['11/4', '12/7', '20/5'])
    expect(merged.position).toEqual({ second: 20, id: 5 })
    // What is left is too new: nothing to read until time passes.
    expect(merged.more).toBe(false)
  })

  it('with nothing to take, stays where it was', () => {
    expect(mergeRuns([run([]), run([])], from, 100)).toEqual({ entries: [], position: from, more: false })
    expect(mergeRuns([run([entry(30, 1)]), run([])], from, 20)).toEqual({ entries: [], position: from, more: false })
  })

  it('holds a list back at the last entry read of a list that has more pages', () => {
    // The live orders have more behind 12/5: something there may come before the trash's 14/9.
    const live = run([entry(11, 4), entry(12, 5)], { exhausted: false })
    const merged = mergeRuns([live, run([entry(12, 3), entry(14, 9)])], from, 100)
    expect(keys(merged.entries)).toEqual(['11/4', '12/3', '12/5'])
    expect(merged.position).toEqual({ second: 12, id: 5 })
    expect(merged.more).toBe(true)
  })

  it('holds the live orders back the same way when it is the trash that has more pages', () => {
    const trash = run([entry(11, 4)], { exhausted: false })
    const merged = mergeRuns([run([entry(10, 8), entry(11, 2), entry(11, 6), entry(15, 1)]), trash], from, 100)
    expect(keys(merged.entries)).toEqual(['10/8', '11/2', '11/4'])
    expect(merged.more).toBe(true)
  })

  it('takes nothing while one list found no page to trust', () => {
    const stalled = run([], { exhausted: false, resumeRank: 4 })
    const merged = mergeRuns([stalled, run([entry(11, 4)])], from, 100)
    expect(merged.entries).toEqual([])
    expect(merged.position).toEqual(from)
    // The rank moved, so the next call gets further.
    expect(merged.more).toBe(true)
  })

  it('does not wait for a list whose remaining entries are all too new', () => {
    const merged = mergeRuns([run([entry(30, 1)]), run([entry(12, 7), entry(15, 8)])], from, 20)
    expect(keys(merged.entries)).toEqual(['12/7', '15/8'])
  })

  it('a full page that ends in entries too new holds the other list at its last settled entry', () => {
    // Not exhausted, so the list is only known up to what was read; 13/8 of the other list waits.
    const live = run([entry(11, 4), entry(25, 5)], { exhausted: false })
    const merged = mergeRuns([live, run([entry(13, 8)])], from, 20)
    expect(keys(merged.entries)).toEqual(['11/4'])
    expect(merged.more).toBe(false)
  })

  it('leaves out an entry that was changed while its page was read, and takes the settled ones around it', () => {
    // 5 was saved again between the shop's query and its answer: it stands in its old place with a new stamp.
    const live = run([entry(11, 4), entry(99, 5), entry(12, 6)])
    const merged = mergeRuns([live, run([entry(13, 8)])], from, 20)
    expect(keys(merged.entries)).toEqual(['11/4', '12/6', '13/8'])
    expect(merged.position).toEqual({ second: 13, id: 8 })
    expect(merged.more).toBe(false)
  })

  it('in a full page with such an entry, goes as far as the last settled entry and no further', () => {
    const live = run([entry(11, 4), entry(99, 5), entry(12, 6)], { exhausted: false })
    const merged = mergeRuns([live, run([entry(12, 2), entry(13, 8)])], from, 20)
    // The list is known up to 12/6; 13/8 of the trash waits for the live list to be read further.
    expect(keys(merged.entries)).toEqual(['11/4', '12/2', '12/6'])
    // Not "more right away": the entry left out has to settle first.
    expect(merged.more).toBe(false)
  })

  it('takes every settled entry of a list read to its end, in whatever order the shop sent them', () => {
    // A shop on the old order storage, in the hour the clocks were set back: sorted by site time, not by UTC.
    const live = run([entry(15, 4), entry(12, 5), entry(30, 9), entry(14, 6)])
    const merged = mergeRuns([live, run([])], from, 20)
    expect(keys(merged.entries)).toEqual(['12/5', '14/6', '15/4'])
    expect(merged.position).toEqual({ second: 15, id: 4 })
  })
})
