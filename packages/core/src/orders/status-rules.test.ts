import { describe, expect, it } from 'vitest'
import type { OrderPhase } from './phases'
import { allowedStatuses, allowedTransitions, canMoveToStatus, factTransition } from './status-rules'

describe('allowedTransitions', () => {
  it.each([
    ['new', ['processing', 'shipped', 'cancelled']],
    ['processing', ['new', 'shipped', 'cancelled']],
    ['shipped', []],
    ['cancelled', []],
  ] as const)('%s → %j', (phase, expected) => {
    expect(allowedTransitions(phase)).toEqual(expected)
  })
})

describe('factTransition', () => {
  it.each([
    ['new', 'cancelled', 'cancelled', null],
    ['new', 'shipped', 'shipped', null],
    ['processing', 'cancelled', 'cancelled', 'cancelled_while_processing'],
    ['processing', 'shipped', 'shipped', null],
    ['shipped', 'cancelled', null, 'channel_fact_conflict'],
    ['shipped', 'shipped', null, null],
    ['cancelled', 'cancelled', null, null],
    ['cancelled', 'shipped', null, 'channel_fact_conflict'],
  ] as const)('%s + fact %s → to %s, reason %s', (phase, fact, to, reason) => {
    expect(factTransition(phase, fact)).toEqual({ to, reason })
  })
})

describe('canMoveToStatus / allowedStatuses', () => {
  const status = (id: string, phase: OrderPhase, active = true) => ({ id, phase, active })
  const all = [
    status('new-default', 'new'),
    status('processing-default', 'processing'),
    status('packing', 'processing'),
    status('packed', 'processing'),
    status('old', 'processing', false),
    status('shipped-default', 'shipped'),
    status('delivered', 'shipped'),
    status('cancelled-default', 'cancelled'),
    status('refunded', 'cancelled'),
  ]
  const ids = (current: { phase: OrderPhase; statusId: string }) => allowedStatuses(current, all).map((candidate) => candidate.id)

  it('offers every active status of a reachable phase, and the other statuses of the same phase', () => {
    expect(ids({ phase: 'processing', statusId: 'packing' })).toEqual([
      'new-default',
      'processing-default',
      'packed',
      'shipped-default',
      'delivered',
      'cancelled-default',
      'refunded',
    ])
  })

  it('never offers the current status or an inactive one', () => {
    expect(canMoveToStatus({ phase: 'processing', statusId: 'packing' }, status('packing', 'processing'))).toBe(false)
    expect(canMoveToStatus({ phase: 'new', statusId: 'new-default' }, status('old', 'processing', false))).toBe(false)
  })

  it('keeps final phases final: only another status of the same phase', () => {
    expect(ids({ phase: 'shipped', statusId: 'shipped-default' })).toEqual(['delivered'])
    expect(ids({ phase: 'cancelled', statusId: 'refunded' })).toEqual(['cancelled-default'])
  })

  it('agrees with allowedTransitions on every phase change', () => {
    for (const from of ['new', 'processing', 'shipped', 'cancelled'] as const) {
      const reached = new Set(allowedStatuses({ phase: from, statusId: 'none' }, all).map((candidate) => candidate.phase))
      reached.delete(from)
      expect([...reached].sort()).toEqual(allowedTransitions(from).sort())
    }
  })
})
