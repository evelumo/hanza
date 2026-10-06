import { describe, expect, it } from 'vitest'
import type { OrderPhase } from './phases'
import { allowedStatuses, allowedTransitions, canMoveToStatus, factTransition, type StatusMoveFrom } from './status-rules'

describe('allowedTransitions', () => {
  it.each([
    ['new', ['processing', 'shipped', 'cancelled']],
    ['processing', ['new', 'shipped', 'cancelled']],
    ['shipped', []],
    ['cancelled', []],
  ] as const)('%s → %j', (phase, expected) => {
    expect(allowedTransitions(phase)).toEqual(expected)
  })

  it.each([
    ['new', ['cancelled']],
    ['processing', ['cancelled']],
    ['shipped', []],
    ['cancelled', []],
  ] as const)('%s awaiting payment → %j', (status, expected) => {
    expect(allowedTransitions(status, true)).toEqual(expected)
  })
})

describe('factTransition', () => {
  it.each([
    ['new', 'cancelled', 'cancelled', null],
    ['new', 'shipped', 'shipped', null],
    ['new', 'paid', null, null],
    ['processing', 'cancelled', 'cancelled', 'cancelled_while_processing'],
    ['processing', 'shipped', 'shipped', null],
    ['processing', 'paid', null, null],
    ['shipped', 'cancelled', null, 'channel_fact_conflict'],
    ['shipped', 'shipped', null, null],
    ['shipped', 'paid', null, null],
    ['cancelled', 'cancelled', null, null],
    ['cancelled', 'shipped', null, 'channel_fact_conflict'],
    ['cancelled', 'paid', null, null],
  ] as const)('%s + fact %s → to %s, reason %s', (phase, fact, to, reason) => {
    expect(factTransition(phase, fact)).toEqual({ to, reason, paid: false })
  })

  it.each([
    ['new', 'paid', null, null, true],
    ['shipped', 'paid', null, null, true],
    ['cancelled', 'paid', null, 'channel_fact_conflict', true],
    ['new', 'cancelled', 'cancelled', null, false],
    ['new', 'shipped', 'shipped', null, false],
  ] as const)('%s awaiting payment + fact %s → to %s, reason %s, paid %s', (phase, fact, to, reason, paid) => {
    expect(factTransition(phase, fact, true)).toEqual({ to, reason, paid })
  })
})

describe('canMoveToStatus / allowedStatuses', () => {
  const status = (id: string, phase: OrderPhase, active = true) => ({ id, phase, active })
  const all = [
    status('new-default', 'new'),
    status('to-check', 'new'),
    status('processing-default', 'processing'),
    status('packing', 'processing'),
    status('packed', 'processing'),
    status('old', 'processing', false),
    status('shipped-default', 'shipped'),
    status('delivered', 'shipped'),
    status('cancelled-default', 'cancelled'),
    status('refunded', 'cancelled'),
  ]
  const ids = (current: StatusMoveFrom) => allowedStatuses(current, all).map((candidate) => candidate.id)

  it('offers every active status of a reachable phase, and the other statuses of the same phase', () => {
    expect(ids({ phase: 'processing', statusId: 'packing' })).toEqual([
      'new-default',
      'to-check',
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

  // #60 on statuses: a label change within phase new is harmless; leaving new is cancelling only.
  it('lets an Order awaiting payment change its status within phase new, and leave new only to cancelled', () => {
    const unpaid = { phase: 'new', statusId: 'new-default', awaitingPayment: true } as const
    expect(ids(unpaid)).toEqual(['to-check', 'cancelled-default', 'refunded'])
    expect(canMoveToStatus(unpaid, status('packing', 'processing'))).toBe(false)
    expect(canMoveToStatus(unpaid, status('delivered', 'shipped'))).toBe(false)
  })

  it('agrees with allowedTransitions on every phase change, paid or not', () => {
    for (const awaitingPayment of [false, true]) {
      for (const from of ['new', 'processing', 'shipped', 'cancelled'] as const) {
        const current = { phase: from, statusId: 'none', awaitingPayment }
        const reached = new Set(allowedStatuses(current, all).map((candidate) => candidate.phase))
        reached.delete(from)
        expect([...reached].sort()).toEqual(allowedTransitions(from, awaitingPayment).sort())
      }
    }
  })
})
