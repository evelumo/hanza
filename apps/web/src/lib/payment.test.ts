import { describe, expect, it } from 'vitest'
import { showsAwaitingPayment } from './payment'

describe('showsAwaitingPayment', () => {
  it.each([
    ['new', true, true],
    ['processing', true, true],
    ['shipped', true, true],
    ['cancelled', true, false],
    ['new', false, false],
    ['shipped', false, false],
    ['cancelled', false, false],
  ] as const)('%s, awaitingPayment %s → %s', (status, awaitingPayment, expected) => {
    expect(showsAwaitingPayment({ status, awaitingPayment })).toBe(expected)
  })
})
