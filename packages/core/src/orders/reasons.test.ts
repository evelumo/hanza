import { describe, expect, it } from 'vitest'
import { addReasons, reasonsAfterCancel } from './reasons'

describe('reasonsAfterCancel', () => {
  it('drops shortage and unmatched_line, keeps the reasons that still need a person', () => {
    expect(reasonsAfterCancel(['unmatched_line', 'shortage', 'cancelled_while_processing', 'channel_fact_conflict'])).toEqual([
      'cancelled_while_processing',
      'channel_fact_conflict',
    ])
    expect(reasonsAfterCancel(['unmatched_line'])).toEqual([])
    expect(reasonsAfterCancel([])).toEqual([])
  })
})

describe('addReasons', () => {
  it('keeps a stable order and reports only new reasons', () => {
    expect(addReasons(['shortage'], ['unmatched_line', 'shortage'])).toEqual({ reasons: ['unmatched_line', 'shortage'], added: ['unmatched_line'] })
  })
})
