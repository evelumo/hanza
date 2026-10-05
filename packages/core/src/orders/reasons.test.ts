import { describe, expect, it } from 'vitest'
import { addReasons, removeReasons } from './reasons'

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
  })

  it('removes the given reasons only', () => {
    expect(removeReasons(['unmatched_line', 'status_push_failed'], ['status_push_failed'])).toEqual(['unmatched_line'])
  })
})
