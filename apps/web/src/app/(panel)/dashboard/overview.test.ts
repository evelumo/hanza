import { describe, expect, it } from 'vitest'
import { attentionItems, connectionsToShow, lastSynchronisedAt, setupSteps, summarizeAttention, type ConnectionState } from './overview'

const noOrders = { total: 0, reasons: [] }

function connection(id: string, health: ConnectionState['health'], syncStates: ConnectionState['syncStates'] = []): ConnectionState {
  return { id, name: `Connection ${id}`, health, syncStates }
}

describe('setupSteps', () => {
  it('lists the first-run path with nothing done for a new organization', () => {
    expect(setupSteps({ connections: 0, linkedOffers: 0, stockRows: 0 })).toEqual([
      { id: 'connect', href: '/connections/new', done: false },
      { id: 'products', href: '/products/offers', done: false },
      { id: 'stock', href: '/products', done: false },
    ])
  })

  it('ticks each step from its own count, in any order', () => {
    const steps = setupSteps({ connections: 2, linkedOffers: 0, stockRows: 3 })
    expect(steps?.map((step) => step.done)).toEqual([true, false, true])
  })

  it('is gone once every step is done', () => {
    expect(setupSteps({ connections: 1, linkedOffers: 1, stockRows: 1 })).toBeNull()
  })
})

describe('summarizeAttention', () => {
  it('counts Orders once and each reason for every Order that has it', () => {
    const summary = summarizeAttention([
      { reasons: ['shortage'], orders: 2 },
      { reasons: ['unmatched_line'], orders: 4 },
      { reasons: ['unmatched_line', 'shortage'], orders: 1 },
      { reasons: ['status_push_failed'], orders: 3 },
    ])
    expect(summary.total).toBe(10)
    expect(summary.reasons).toEqual([
      { reason: 'unmatched_line', count: 5 },
      { reason: 'shortage', count: 3 },
      { reason: 'status_push_failed', count: 3 },
    ])
  })

  it('ignores a group without reasons and a reason listed twice', () => {
    expect(summarizeAttention([{ reasons: [], orders: 7 }])).toEqual(noOrders)
    expect(summarizeAttention([{ reasons: ['shortage', 'shortage'], orders: 2 }])).toEqual({ total: 2, reasons: [{ reason: 'shortage', count: 2 }] })
  })
})

describe('attentionItems', () => {
  it('is empty when nothing waits', () => {
    const connections = [connection('a', 'ok'), connection('b', 'unknown')]
    expect(attentionItems({ connections, orders: noOrders, unlinkedOffers: 0, stockUnsetOffers: 0 })).toEqual([])
  })

  it('puts Connections that do not synchronise before Orders and Offers', () => {
    const items = attentionItems({
      connections: [
        connection('a', 'auth_expired'),
        connection('b', 'ok'),
        connection('c', 'failing', [
          { stream: 'offers_pull', lastErrorKind: null },
          { stream: 'orders_pull', lastErrorKind: 'permanent' },
        ]),
      ],
      orders: { total: 3, reasons: [{ reason: 'shortage', count: 3 }] },
      unlinkedOffers: 5,
      stockUnsetOffers: 2,
    })
    expect(items).toEqual([
      { kind: 'connection_failing', href: '/connections/c', name: 'Connection c', errors: [{ stream: 'orders_pull', kind: 'permanent' }] },
      { kind: 'connection_sign_in', href: '/connections/a', name: 'Connection a' },
      { kind: 'orders', href: '/orders?attention=1', total: 3, reasons: [{ reason: 'shortage', count: 3 }] },
      { kind: 'unlinked_offers', href: '/products/offers', count: 5 },
      { kind: 'stock_unset_offers', href: '/products/offers#stock-not-set', count: 2 },
    ])
  })

  it('counts Offers whose Product has unset Stock on their own, after the Offers without a Product', () => {
    expect(attentionItems({ connections: [], orders: noOrders, unlinkedOffers: 0, stockUnsetOffers: 3 })).toEqual([
      { kind: 'stock_unset_offers', href: '/products/offers#stock-not-set', count: 3 },
    ])
  })
})

describe('connectionsToShow', () => {
  it('lists the Connections in trouble first and keeps the given order otherwise', () => {
    const connections = [connection('a', 'ok'), connection('b', 'unknown'), connection('c', 'auth_expired'), connection('d', 'ok'), connection('e', 'failing')]
    const { shown, more } = connectionsToShow(connections)
    expect(shown.map(({ id }) => id)).toEqual(['e', 'c', 'b', 'a', 'd'])
    expect(more).toBe(0)
  })

  it('says how many it left out', () => {
    const connections = [connection('a', 'ok'), connection('b', 'ok'), connection('c', 'failing')]
    const { shown, more } = connectionsToShow(connections, 2)
    expect(shown.map(({ id }) => id)).toEqual(['c', 'a'])
    expect(more).toBe(1)
  })
})

describe('lastSynchronisedAt', () => {
  it('is the latest success of any stream', () => {
    const earlier = new Date('2026-10-01T08:00:00Z')
    const later = new Date('2026-10-02T08:00:00Z')
    expect(lastSynchronisedAt([{ lastSucceededAt: earlier }, { lastSucceededAt: null }, { lastSucceededAt: later }])).toBe(later)
  })

  it('is null while nothing has succeeded', () => {
    expect(lastSynchronisedAt([])).toBeNull()
    expect(lastSynchronisedAt([{ lastSucceededAt: null }])).toBeNull()
  })
})
