import { describe, expect, it } from 'vitest'
import { confirmationTimedOut, nextShipmentCheck, SHIPMENT_CHECK_MS } from './schedule'
import { statusStage, type ShipmentStatus } from './statuses'

const createdAt = new Date('2026-10-10T08:00:00Z')
const after = (ms: number) => new Date(createdAt.getTime() + ms)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** How long after `now` a Shipment in `status` is due again; null when it is not checked any more. */
function wait(status: ShipmentStatus, age: number): number | null {
  const now = after(age)
  const next = nextShipmentCheck(status, createdAt, now)
  return next === null ? null : next.getTime() - now.getTime()
}

describe('nextShipmentCheck', () => {
  it('checks an unconfirmed Shipment every tick for its first 10 minutes, then every 10 minutes', () => {
    for (const status of ['requested', 'pending'] as const) {
      expect(wait(status, 0)).toBe(30_000)
      expect(wait(status, 10 * MINUTE - 1)).toBe(30_000)
      expect(wait(status, 10 * MINUTE)).toBe(10 * MINUTE)
      expect(wait(status, 23 * HOUR)).toBe(10 * MINUTE)
    }
    // Under a tick, so the next tick finds it due.
    expect(SHIPMENT_CHECK_MS.fresh).toBeLessThan(60_000)
  })

  it('checks a ready Shipment every 15 minutes and one the Carrier has every hour, however old', () => {
    expect(wait('ready', MINUTE)).toBe(15 * MINUTE)
    expect(wait('ready', 3 * DAY)).toBe(15 * MINUTE)
    for (const status of ['in_transit', 'awaiting_pickup', 'delivery_problem'] as const) {
      expect(wait(status, MINUTE)).toBe(HOUR)
      expect(wait(status, 30 * DAY)).toBe(HOUR)
    }
  })

  it('checks a ready Shipment whose Label is awaited every tick during its first hour, and no other status sooner for it', () => {
    const awaiting = (status: ShipmentStatus, age: number) => {
      const now = after(age)
      return nextShipmentCheck(status, createdAt, now, { awaitsLabel: true })!.getTime() - now.getTime()
    }
    expect(awaiting('ready', MINUTE)).toBe(30_000)
    // Confirmed late, the Label a moment after: still within the hour.
    expect(awaiting('ready', 45 * MINUTE)).toBe(30_000)
    expect(awaiting('ready', HOUR - 1)).toBe(30_000)
    expect(awaiting('ready', HOUR)).toBe(15 * MINUTE)
    expect(awaiting('pending', 20 * MINUTE)).toBe(10 * MINUTE)
    expect(awaiting('in_transit', MINUTE)).toBe(HOUR)
    expect(nextShipmentCheck('delivered', createdAt, after(MINUTE), { awaitsLabel: true })).toBeNull()
  })

  it('owes a final Shipment nothing', () => {
    for (const status of ['delivered', 'returned', 'cancelled', 'failed'] as const) expect(wait(status, MINUTE)).toBeNull()
  })

  it('stops checking a Shipment that is not final 60 days after it was requested', () => {
    expect(wait('in_transit', 60 * DAY - 1)).toBe(HOUR)
    expect(wait('in_transit', 60 * DAY)).toBeNull()
    expect(wait('ready', 61 * DAY)).toBeNull()
  })
})

describe('statusStage', () => {
  it('orders the statuses by how far a Shipment has got, so a report can be told to go backwards', () => {
    const stages = Object.fromEntries(
      (['requested', 'pending', 'ready', 'in_transit', 'awaiting_pickup', 'delivery_problem', 'delivered', 'returned', 'cancelled', 'failed'] as const).map((status) => [
        status,
        statusStage(status),
      ]),
    )
    expect(stages).toEqual({
      requested: 0,
      pending: 0,
      ready: 1,
      in_transit: 2,
      awaiting_pickup: 2,
      delivery_problem: 2,
      delivered: 3,
      returned: 3,
      cancelled: 3,
      failed: 3,
    })
  })
})

describe('confirmationTimedOut', () => {
  it('is true for a Shipment still unconfirmed 24 hours after it was requested, and never for a confirmed one', () => {
    expect(confirmationTimedOut('requested', createdAt, after(DAY - 1))).toBe(false)
    expect(confirmationTimedOut('requested', createdAt, after(DAY))).toBe(true)
    expect(confirmationTimedOut('pending', createdAt, after(2 * DAY))).toBe(true)
    for (const status of ['ready', 'in_transit', 'delivered', 'failed'] as const) {
      expect(confirmationTimedOut(status, createdAt, after(30 * DAY))).toBe(false)
    }
  })
})
