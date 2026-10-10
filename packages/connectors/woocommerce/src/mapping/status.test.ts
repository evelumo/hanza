import { ORDER_PHASES, type OrderPhase } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { CANCELLED_STATUSES, isDraftStatus, OPEN_STATUSES, phaseSetsStatus, targetStatus } from './status'

// `packing` stands for a status a plugin registered, as in the sandbox.
const STATUSES = ['pending', 'on-hold', 'processing', 'completed', 'cancelled', 'refunded', 'failed', 'trash', 'packing', 'checkout-draft', 'auto-draft']

describe('targetStatus', () => {
  // The spec's "Order phases" table, one row per phase; a status that is not named gets no call.
  const table: Record<OrderPhase, Record<string, string>> = {
    new: {},
    processing: { pending: 'processing', 'on-hold': 'processing', failed: 'processing' },
    shipped: { pending: 'completed', 'on-hold': 'completed', processing: 'completed', packing: 'completed' },
    cancelled: { pending: 'cancelled', 'on-hold': 'cancelled', processing: 'cancelled', packing: 'cancelled' },
  }

  for (const phase of ORDER_PHASES) {
    it.each(STATUSES.map((status) => [status, table[phase][status] ?? null] as const))(`phase ${phase}, order %s → %s`, (status, expected) => {
      expect(targetStatus(status, phase)).toBe(expected)
    })
  }

  it('never asks for the status the order already has, so a repeated call changes nothing', () => {
    for (const phase of ORDER_PHASES) {
      for (const status of STATUSES) expect(targetStatus(status, phase)).not.toBe(status)
    }
  })

  it('never reopens: an order it moved is left alone when the same phase comes again', () => {
    for (const phase of ORDER_PHASES) {
      for (const status of STATUSES) {
        const target = targetStatus(status, phase)
        if (target !== null) expect(targetStatus(target, phase)).toBeNull()
      }
    }
  })

  it('never ships or cancels an order WooCommerce already closed', () => {
    for (const phase of ['shipped', 'cancelled'] as const) {
      for (const status of ['completed', ...CANCELLED_STATUSES]) expect(targetStatus(status, phase)).toBeNull()
    }
  })

  it('takes up a failed order again only for phase processing (the Buyer paid after all)', () => {
    expect(targetStatus('failed', 'processing')).toBe('processing')
    expect(targetStatus('cancelled', 'processing')).toBeNull()
    expect(targetStatus('refunded', 'processing')).toBeNull()
    expect(targetStatus('trash', 'processing')).toBeNull()
  })

  it('never touches a checkout that was not placed', () => {
    for (const phase of ORDER_PHASES) {
      for (const status of ['checkout-draft', 'auto-draft']) expect(targetStatus(status, phase)).toBeNull()
    }
  })
})

describe('the status lists', () => {
  it('lists the open statuses and the cancelled ones without overlap', () => {
    expect([...OPEN_STATUSES]).toEqual(['pending', 'on-hold', 'processing'])
    expect(CANCELLED_STATUSES).toEqual(['cancelled', 'refunded', 'failed', 'trash'])
  })

  it('knows a checkout that was never placed from an order, whatever a plugin calls its statuses', () => {
    expect(STATUSES.filter(isDraftStatus)).toEqual(['checkout-draft', 'auto-draft'])
  })
})

describe('phaseSetsStatus', () => {
  it('is false exactly for the phases that never change an order, so those need no request', () => {
    for (const phase of ORDER_PHASES) {
      expect(phaseSetsStatus(phase)).toBe(STATUSES.some((status) => targetStatus(status, phase) !== null))
    }
    expect(phaseSetsStatus('new')).toBe(false)
  })
})
