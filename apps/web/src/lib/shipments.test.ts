import { SHIPMENT_STATUSES, type ShippingService } from '@hanza/connector-sdk'
import type { ShipmentRow } from '@hanza/core'
import type { ShipmentStatus } from '@hanza/db'
import { describe, expect, it } from 'vitest'
import { catalogues } from '@/i18n/catalogues'
import { translatorFor } from '@/i18n/testing'
import { shipmentStatusLabel } from './labels'
import { canCheckShipment, defaultServiceId, pickupSettling, shipmentBlocker, shipmentNote, shipmentSettling, shipmentStatusTone } from './shipments'

const statuses: ShipmentStatus[] = ['requested', ...SHIPMENT_STATUSES]

const row = (overrides: Partial<ShipmentRow> = {}) => ({
  status: 'ready' as ShipmentStatus,
  externalId: 'carrier-1' as string | null,
  failureCode: null,
  cancelRefusedCode: null,
  cancelRequestedAt: null,
  hasLabel: true,
  createdAt: new Date('2026-10-10T10:00:00Z'),
  ...overrides,
})

describe('the Shipment status badge', () => {
  it('has a tone and a name in both languages for every status, Hanza’s own `requested` included', () => {
    expect(Object.keys(shipmentStatusTone).sort()).toEqual([...statuses].sort())
    for (const locale of ['en', 'pl'] as const) {
      const names = statuses.map((status) => shipmentStatusLabel(translatorFor(locale), status))
      expect(new Set(names).size, locale).toBe(statuses.length)
    }
    expect(shipmentStatusLabel(translatorFor('en'), 'ready')).toBe('Ready to send')
    expect(catalogues.pl.labels.shipmentStatus.ready).not.toBe(catalogues.en.labels.shipmentStatus.ready)
  })

  it('shows a Shipment being arranged with the Carrier as on its way, never as a problem', () => {
    expect(shipmentStatusTone.requested).toBe('info')
    expect(shipmentStatusTone.pending).toBe('info')
    expect(shipmentStatusTone.failed).toBe('critical')
    expect(shipmentStatusTone.delivery_problem).toBe('warning')
    expect(shipmentStatusTone.delivered).toBe('success')
    expect(shipmentStatusTone.cancelled).toBe('neutral')
  })
})

describe('shipmentNote', () => {
  it('explains a failure of Hanza’s own by its reason, and hands a Carrier’s code on as it is', () => {
    expect(shipmentNote(row({ status: 'failed', failureCode: 'carrier_timeout' }))).toEqual({ kind: 'failed', reason: 'carrier_timeout', code: null })
    expect(shipmentNote(row({ status: 'failed', failureCode: 'target_point.does_not_exist' }))).toEqual({
      kind: 'failed',
      reason: null,
      code: 'target_point.does_not_exist',
    })
    expect(shipmentNote(row({ status: 'failed', failureCode: null }))).toEqual({ kind: 'failed', reason: null, code: null })
    // A name every object has is not a reason the catalogue explains.
    expect(shipmentNote(row({ status: 'failed', failureCode: 'toString' }))).toEqual({ kind: 'failed', reason: null, code: 'toString' })
  })

  it('has a sentence in both languages for every reason the core sets', () => {
    const reasons = ['carrier_timeout', 'buyer_data_erased', 'buyer_data_unreadable', 'request_invalid', 'service_unavailable', 'duplicate_external_id']
    expect(Object.keys(catalogues.en.labels.shipmentFailure).sort()).toEqual([...reasons].sort())
    expect(Object.keys(catalogues.pl.labels.shipmentFailure).sort()).toEqual([...reasons].sort())
  })

  it('says what is happening to a Shipment that is not final, the cancel first', () => {
    expect(shipmentNote(row({ status: 'requested', externalId: null, hasLabel: false }))).toEqual({ kind: 'arranging' })
    expect(shipmentNote(row({ status: 'pending', hasLabel: false }))).toEqual({ kind: 'arranging' })
    expect(shipmentNote(row({ status: 'ready', hasLabel: false }))).toEqual({ kind: 'labelPending' })
    expect(shipmentNote(row({ status: 'ready' }))).toEqual({ kind: 'ready' })
    expect(shipmentNote(row({ status: 'ready', cancelRequestedAt: new Date() }))).toEqual({ kind: 'cancelRequested' })
    expect(shipmentNote(row({ status: 'ready', cancelRefusedCode: 'too_late' }))).toEqual({ kind: 'cancelRefused', code: 'too_late' })
    expect(shipmentNote(row({ status: 'in_transit', cancelRefusedCode: 'too_late' }))).toEqual({ kind: 'cancelRefused', code: 'too_late' })
  })

  it('has nothing to add once the Carrier has the parcel or the Shipment is over', () => {
    for (const status of ['in_transit', 'awaiting_pickup', 'delivery_problem', 'delivered', 'returned', 'cancelled'] as const) {
      expect(shipmentNote(row({ status })), status).toBeNull()
    }
  })
})

describe('canCheckShipment', () => {
  it('is for a Shipment the Carrier knows and may still say something about', () => {
    expect(canCheckShipment(row({ status: 'pending' }))).toBe(true)
    expect(canCheckShipment(row({ status: 'in_transit' }))).toBe(true)
    expect(canCheckShipment(row({ status: 'requested', externalId: null }))).toBe(false)
    for (const status of ['delivered', 'returned', 'cancelled', 'failed'] as const) expect(canCheckShipment(row({ status })), status).toBe(false)
  })
})

describe('shipmentSettling', () => {
  const created = new Date('2026-10-10T10:00:00Z')
  const soon = new Date('2026-10-10T10:01:00Z')
  const later = new Date('2026-10-10T10:11:00Z')

  it('holds while the Carrier is being asked for the Shipment, its Label or its cancellation', () => {
    expect(shipmentSettling(row({ status: 'requested', hasLabel: false, createdAt: created }), soon)).toBe(true)
    expect(shipmentSettling(row({ status: 'pending', hasLabel: false, createdAt: created }), soon)).toBe(true)
    expect(shipmentSettling(row({ status: 'ready', hasLabel: false, createdAt: created }), soon)).toBe(true)
    expect(shipmentSettling(row({ status: 'in_transit', cancelRequestedAt: soon, createdAt: created }), later)).toBe(true)
  })

  it('ends with the Label, with a final status, and for a Shipment the Carrier keeps waiting', () => {
    expect(shipmentSettling(row({ status: 'ready', createdAt: created }), soon)).toBe(false)
    expect(shipmentSettling(row({ status: 'in_transit', hasLabel: false, createdAt: created }), soon)).toBe(false)
    expect(shipmentSettling(row({ status: 'failed', hasLabel: false, createdAt: created }), soon)).toBe(false)
    expect(shipmentSettling(row({ status: 'cancelled', cancelRequestedAt: soon, createdAt: created }), soon)).toBe(false)
    expect(shipmentSettling(row({ status: 'pending', hasLabel: false, createdAt: created }), later)).toBe(false)
  })
})

describe('pickupSettling', () => {
  const taken = new Date('2026-10-10T10:00:00Z')
  const justNow = new Date('2026-10-10T10:00:02Z')

  it('holds when a parcel was taken a moment ago and the Order was still read as open', () => {
    expect(pickupSettling({ phase: 'new' }, [{ handedOverAt: null }, { handedOverAt: taken }], justNow)).toBe(true)
    expect(pickupSettling({ phase: 'processing' }, [{ handedOverAt: taken }], justNow)).toBe(true)
    // The web server's clock may be behind the database's.
    expect(pickupSettling({ phase: 'new' }, [{ handedOverAt: justNow }], taken)).toBe(true)
  })

  it('does not once the Order is shipped, without a pickup, or for an Order that stays open because it could not ship', () => {
    expect(pickupSettling({ phase: 'shipped' }, [{ handedOverAt: taken }], justNow)).toBe(false)
    expect(pickupSettling({ phase: 'cancelled' }, [{ handedOverAt: taken }], justNow)).toBe(false)
    expect(pickupSettling({ phase: 'new' }, [{ handedOverAt: null }], justNow)).toBe(false)
    expect(pickupSettling({ phase: 'new' }, [], justNow)).toBe(false)
    expect(pickupSettling({ phase: 'new' }, [{ handedOverAt: taken }], new Date('2026-10-10T10:01:00Z'))).toBe(false)
  })
})

describe('shipmentBlocker', () => {
  const order = { phase: 'new', awaitingPayment: false, buyerDataState: 'present' } as const

  it('lets an open, paid Order with its Buyer data get a Shipment', () => {
    expect(shipmentBlocker(order)).toBeNull()
    expect(shipmentBlocker({ ...order, phase: 'processing' })).toBeNull()
  })

  it('names the one reason, in the order the core refuses', () => {
    expect(shipmentBlocker({ ...order, phase: 'shipped', awaitingPayment: true, buyerDataState: 'erased' })).toBe('shipped')
    expect(shipmentBlocker({ ...order, phase: 'cancelled' })).toBe('cancelled')
    expect(shipmentBlocker({ ...order, awaitingPayment: true, buyerDataState: 'unreadable' })).toBe('awaitingPayment')
    expect(shipmentBlocker({ ...order, buyerDataState: 'erased' })).toBe('buyerErased')
    expect(shipmentBlocker({ ...order, buyerDataState: 'unreadable' })).toBe('buyerUnreadable')
  })
})

describe('defaultServiceId', () => {
  const locker: ShippingService = { id: 'locker', name: 'Locker', destination: 'pickup_point', parcel: { type: 'presets', presets: [{ id: 's', name: 'S' }] }, cashOnDelivery: true }
  const courier: ShippingService = { id: 'courier', name: 'Courier', destination: 'address', parcel: { type: 'dimensions' }, cashOnDelivery: false }

  it('starts on a service that goes where the Buyer asked, else on the first', () => {
    expect(defaultServiceId([courier, locker], true)).toBe('locker')
    expect(defaultServiceId([locker, courier], false)).toBe('courier')
    expect(defaultServiceId([courier], true)).toBe('courier')
    expect(defaultServiceId([], true)).toBeUndefined()
  })
})
