import { describe, expect, it } from 'vitest'
import { allowedTransitions, factTransition } from './status-rules'

describe('allowedTransitions', () => {
  it.each([
    ['new', ['processing', 'shipped', 'cancelled']],
    ['processing', ['new', 'shipped', 'cancelled']],
    ['shipped', []],
    ['cancelled', []],
  ] as const)('%s → %j', (status, expected) => {
    expect(allowedTransitions(status)).toEqual(expected)
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
  ] as const)('%s + fact %s → to %s, reason %s', (status, fact, to, reason) => {
    expect(factTransition(status, fact)).toEqual({ to, reason, paid: false })
  })

  it.each([
    ['new', 'paid', null, null, true],
    ['shipped', 'paid', null, null, true],
    ['cancelled', 'paid', null, 'channel_fact_conflict', true],
    ['new', 'cancelled', 'cancelled', null, false],
    ['new', 'shipped', 'shipped', null, false],
  ] as const)('%s awaiting payment + fact %s → to %s, reason %s, paid %s', (status, fact, to, reason, paid) => {
    expect(factTransition(status, fact, true)).toEqual({ to, reason, paid })
  })
})
