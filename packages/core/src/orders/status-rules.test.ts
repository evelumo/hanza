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
  ] as const)('%s + fact %s → to %s, reason %s', (status, fact, to, reason) => {
    expect(factTransition(status, fact)).toEqual({ to, reason })
  })
})
