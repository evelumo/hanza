import { describe, expect, it } from 'vitest'
import { addReasons, reasonsAfterCancel, removeReasons } from './reasons'

describe('attention reasons', () => {
  it('keeps a stable order and reports only the reasons that were added', () => {
    expect(addReasons(['status_push_failed', 'unmatched_line'], ['shortage', 'status_push_failed'])).toEqual({
      reasons: ['unmatched_line', 'shortage', 'status_push_failed'],
      added: ['shortage'],
    })
    expect(addReasons([], ['status_push_failed', 'channel_fact_conflict'])).toEqual({
      reasons: ['channel_fact_conflict', 'status_push_failed'],
      added: ['status_push_failed', 'channel_fact_conflict'],
    })
    expect(addReasons(['shortage'], ['unmatched_line', 'shortage'])).toEqual({ reasons: ['unmatched_line', 'shortage'], added: ['unmatched_line'] })
  })

  it('removes the given reasons only', () => {
    expect(removeReasons(['unmatched_line', 'status_push_failed'], ['status_push_failed'])).toEqual(['unmatched_line'])
  })
})

describe('reasonsAfterCancel', () => {
  it('drops shortage and unmatched_line, keeps the reasons that still need a person', () => {
    expect(reasonsAfterCancel(['unmatched_line', 'shortage', 'cancelled_while_processing', 'channel_fact_conflict'])).toEqual([
      'cancelled_while_processing',
      'channel_fact_conflict',
    ])
    expect(reasonsAfterCancel(['unmatched_line', 'status_push_failed'])).toEqual(['status_push_failed'])
    expect(reasonsAfterCancel(['unmatched_line'])).toEqual([])
    expect(reasonsAfterCancel([])).toEqual([])
  })
})
