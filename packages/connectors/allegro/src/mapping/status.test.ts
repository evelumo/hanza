import { ORDER_PHASES } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { FULFILLMENT_STATUSES } from '../api/orders'
import { FULFILLMENT_STATUS_FOR_PHASE, fulfillmentStatusFor } from './status'

describe('fulfillmentStatusFor', () => {
  it.each([
    ['new', 'NEW'],
    ['processing', 'PROCESSING'],
    ['shipped', 'SENT'],
    ['cancelled', 'CANCELLED'],
  ] as const)('maps the phase %s to %s', (phase, status) => {
    expect(fulfillmentStatusFor(phase)).toBe(status)
  })

  it('covers every Order phase with a status Allegro knows', () => {
    for (const phase of ORDER_PHASES) {
      expect(FULFILLMENT_STATUSES).toContain(FULFILLMENT_STATUS_FOR_PHASE[phase])
    }
  })
})
