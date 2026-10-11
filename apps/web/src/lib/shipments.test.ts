import { SHIPMENT_STATUSES, type ShippingService } from '@hanza/connector-sdk'
import { SHIPMENT_LABEL_FAILURES, type ShipmentRow } from '@hanza/core'
import type { ShipmentStatus } from '@hanza/db'
import { describe, expect, it } from 'vitest'
import { catalogues } from '@/i18n/catalogues'
import { isMessageKey } from '@/i18n/keys'
import { translatorFor } from '@/i18n/testing'
import { shipmentStatusLabel } from './labels'
import {
  defaultServiceId,
  labelFailureKey,
  pickupSettling,
  shipmentBlocker,
  shipmentFailureKey,
  shipmentNotes,
  shipmentSettling,
  shipmentStatusTone,
  type ShipmentNote,
} from './shipments'

const statuses: ShipmentStatus[] = ['requested', ...SHIPMENT_STATUSES]
const created = new Date('2026-10-10T10:00:00Z')

/** A ready Shipment with its Label, at a Carrier that cancels through Hanza. */
const row = (overrides: Partial<ShipmentRow> = {}) => ({
  status: 'ready' as ShipmentStatus,
  carrierStatus: null as string | null,
  failureCode: null as string | null,
  cancelRefusedCode: null as string | null,
  cancelRequestedAt: null as Date | null,
  canCancel: true,
  canCheck: true,
  hasLabel: true,
  labelFailureCode: null as ShipmentRow['labelFailureCode'],
  mayExistAtCarrier: false,
  handedOverAt: null as Date | null,
  createdAt: created,
  ...overrides,
})
const working = { trouble: false, needsSignIn: false, canCancel: true }
const failing = { trouble: true, needsSignIn: false, canCancel: true }
const needsSignIn = { trouble: true, needsSignIn: true, canCancel: true }
const kinds = (notes: ShipmentNote[]) => notes.map((note) => note.kind)

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

describe('shipmentFailureKey', () => {
  const reasons = ['carrier_timeout', 'buyer_data_erased', 'buyer_data_unreadable', 'request_invalid', 'service_unavailable', 'duplicate_external_id']

  it('has a sentence in both languages for every reason the core sets, and for nothing else in the catalogue', () => {
    for (const reason of reasons) expect(shipmentFailureKey(reason)).toBe(`labels.shipmentFailure.${reason}`)
    expect(Object.keys(catalogues.en.labels.shipmentFailure).sort()).toEqual([...reasons].sort())
    expect(Object.keys(catalogues.pl.labels.shipmentFailure).sort()).toEqual([...reasons].sort())
    for (const failure of SHIPMENT_LABEL_FAILURES) expect(isMessageKey(labelFailureKey[failure]), failure).toBe(true)
  })

  it('never turns a Carrier’s code into a message key, whatever it spells', () => {
    // Dots are a path to the message library; these name real messages and real object members.
    for (const code of ['target_point.does_not_exist', 'labels.shipmentFailure.carrier_timeout', 'common.saving', 'toString', '__proto__', 'constructor', '']) {
      expect(shipmentFailureKey(code), code).toBeNull()
    }
    expect(shipmentFailureKey(null)).toBeNull()
  })
})

describe('shipmentNotes', () => {
  it('explains a failure of Hanza’s own by its sentence, and hands a Carrier’s code on as text', () => {
    expect(shipmentNotes(row({ status: 'failed', canCheck: false, canCancel: false, hasLabel: false, failureCode: 'carrier_timeout' }), working)).toEqual([
      { kind: 'failed', reason: 'labels.shipmentFailure.carrier_timeout', code: null },
    ])
    const refused = row({ status: 'failed', canCheck: false, canCancel: false, hasLabel: false, failureCode: 'common.saving' })
    expect(shipmentNotes(refused, working)).toEqual([{ kind: 'failed', reason: null, code: 'common.saving' }])
    expect(shipmentNotes({ ...refused, failureCode: null }, working)).toEqual([{ kind: 'failed', reason: null, code: null }])
  })

  it('says of a Shipment the Carrier was asked for without an answer that a label may exist there, also once it is over', () => {
    const waiting = row({ status: 'requested', canCheck: false, hasLabel: false, mayExistAtCarrier: true })
    // Still to be asked for again: that, not "being arranged", and not the Connection, which fails at the same time.
    expect(kinds(shipmentNotes(waiting, working))).toEqual(['retrying'])
    expect(kinds(shipmentNotes(waiting, failing))).toEqual(['retrying'])
    // A Connection that waits for a sign-in is skipped by the scheduler: nobody asks again until it is mended, so
    // no retry is promised; the label that may exist is still said.
    expect(kinds(shipmentNotes(waiting, needsSignIn))).toEqual(['connectionWaiting', 'mayExistAtCarrier'])
    const over = { canCheck: false, canCancel: false, hasLabel: false, mayExistAtCarrier: true }
    expect(kinds(shipmentNotes(row({ ...over, status: 'cancelled' }), working))).toEqual(['mayExistAtCarrier'])
    expect(kinds(shipmentNotes(row({ ...over, status: 'failed', failureCode: 'carrier_timeout' }), working))).toEqual(['failed', 'mayExistAtCarrier'])
    // A Shipment the Carrier itself refused is not one.
    expect(kinds(shipmentNotes(row({ ...over, status: 'failed', failureCode: 'no_phone', mayExistAtCarrier: false }), working))).toEqual(['failed'])
  })

  it('tells a request that waits for its Connection from one the worker is about to send', () => {
    const requested = row({ status: 'requested', canCheck: false, hasLabel: false })
    expect(kinds(shipmentNotes(requested, working))).toEqual(['arranging'])
    expect(kinds(shipmentNotes(requested, failing))).toEqual(['connectionWaiting'])
    expect(kinds(shipmentNotes(requested, needsSignIn))).toEqual(['connectionWaiting'])
    expect(kinds(shipmentNotes(requested, null))).toEqual(['arranging'])
  })

  it('shows what the Carrier says about a Shipment it has not confirmed, since nothing else says what it waits for', () => {
    const pending = row({ status: 'pending', hasLabel: false })
    expect(shipmentNotes({ ...pending, carrierStatus: 'debt_collection' }, working)).toEqual([{ kind: 'unconfirmed', code: 'debt_collection' }])
    expect(shipmentNotes(pending, working)).toEqual([{ kind: 'arranging' }])
  })

  it('says where the Label is: ready, on its way, or not to be had here', () => {
    expect(kinds(shipmentNotes(row(), working))).toEqual(['ready'])
    expect(kinds(shipmentNotes(row({ hasLabel: false }), working))).toEqual(['labelPending'])
    expect(shipmentNotes(row({ hasLabel: false, labelFailureCode: 'refused' }), working)).toEqual([
      { kind: 'labelFailed', reason: 'labels.shipmentLabelFailure.refused' },
    ])
    // Once the Carrier has the parcel nobody prints anything.
    expect(shipmentNotes(row({ status: 'in_transit', hasLabel: false, labelFailureCode: 'too_large', canCancel: false, handedOverAt: created }), working)).toEqual([])
  })

  it('says of a cancel asked while the request was still out that it is done here, not put to the Carrier', () => {
    const asked = row({ status: 'requested', canCheck: false, canCancel: false, hasLabel: false, cancelRequestedAt: created })
    expect(kinds(shipmentNotes(asked, working))).toEqual(['cancelQueued'])
    // Not "asked again in 5 minutes": the next thing that happens to it is the cancel.
    expect(kinds(shipmentNotes({ ...asked, mayExistAtCarrier: true }, { trouble: true, needsSignIn: true, canCancel: false }))).toEqual(['cancelQueued'])
  })

  it('says what became of a cancel: asked, refused with the Carrier’s code, or not something this Carrier does', () => {
    expect(kinds(shipmentNotes(row({ cancelRequestedAt: created, canCancel: false }), working))).toEqual(['cancelRequested', 'ready'])
    expect(shipmentNotes(row({ cancelRefusedCode: 'too_late' }), working)).toEqual([{ kind: 'cancelRefused', code: 'too_late' }, { kind: 'ready' }])
    expect(kinds(shipmentNotes(row({ cancelRefusedCode: 'cancel_unsupported', canCancel: false }), { trouble: false, needsSignIn: false, canCancel: false }))).toEqual([
      'cancelUnsupported',
      'ready',
    ])
  })

  it('says once, for a Shipment at a Carrier that cannot cancel through Hanza, where it is cancelled instead', () => {
    const noCancel = { trouble: false, needsSignIn: false, canCancel: false }
    expect(kinds(shipmentNotes(row({ canCancel: false }), noCancel))).toEqual(['ready', 'cancelAtCarrier'])
    expect(kinds(shipmentNotes(row({ status: 'pending', hasLabel: false, canCancel: false, carrierStatus: 'created' }), noCancel))).toEqual([
      'unconfirmed',
      'cancelAtCarrier',
    ])
    // Not before the Carrier has it (it is cancelled here then), not once the parcel is taken, not when it is over.
    expect(kinds(shipmentNotes(row({ status: 'requested', canCheck: false, hasLabel: false }), noCancel))).toEqual(['arranging'])
    expect(kinds(shipmentNotes(row({ status: 'in_transit', canCancel: false, handedOverAt: created }), noCancel))).toEqual([])
    expect(kinds(shipmentNotes(row({ status: 'delivered', canCheck: false, canCancel: false, hasLabel: false, handedOverAt: created }), noCancel))).toEqual([])
    // And not for a Carrier that can: there the button is missing for another reason (a cancel is on its way).
    expect(kinds(shipmentNotes(row({ canCancel: false, cancelRequestedAt: created }), working))).toEqual(['cancelRequested', 'ready'])
  })

  it('has a sentence in both languages for every note', () => {
    const all: ShipmentNote['kind'][] = [
      'failed', 'mayExistAtCarrier', 'retrying', 'connectionWaiting', 'arranging', 'unconfirmed', 'cancelRequested', 'cancelQueued', 'cancelRefused',
      'cancelUnsupported', 'ready', 'labelPending', 'labelFailed', 'cancelAtCarrier',
    ]
    for (const kind of all) {
      expect(isMessageKey(`orders.shipments.note.${kind}`), kind).toBe(true)
      expect(catalogues.pl.orders.shipments.note[kind]).not.toBe(catalogues.en.orders.shipments.note[kind])
    }
  })
})

describe('shipmentSettling', () => {
  const soon = new Date('2026-10-10T10:00:08Z')
  const later = new Date('2026-10-10T10:00:30Z')

  it('holds for the few seconds in which a new Shipment gets its Carrier’s answer and its Label', () => {
    expect(shipmentSettling(row({ status: 'requested', hasLabel: false }), soon)).toBe(true)
    expect(shipmentSettling(row({ status: 'pending', hasLabel: false }), soon)).toBe(true)
    expect(shipmentSettling(row({ status: 'ready', hasLabel: false }), soon)).toBe(true)
  })

  it('holds for a few seconds after a person asked to cancel, however old the Shipment is', () => {
    expect(shipmentSettling(row({ cancelRequestedAt: new Date('2026-10-10T10:00:25Z') }), later)).toBe(true)
    expect(shipmentSettling(row({ cancelRequestedAt: created }), later)).toBe(false)
  })

  it('ends with the Label, and never polls a Shipment that waits for longer than moments', () => {
    expect(shipmentSettling(row(), soon)).toBe(false)
    expect(shipmentSettling(row({ status: 'ready', hasLabel: false, labelFailureCode: 'refused' }), soon)).toBe(false)
    expect(shipmentSettling(row({ status: 'in_transit', hasLabel: false }), soon)).toBe(false)
    expect(shipmentSettling(row({ status: 'failed', hasLabel: false }), soon)).toBe(false)
    // A Connection that is failing, a Carrier that takes its time: the window is over, whatever the status.
    expect(shipmentSettling(row({ status: 'requested', hasLabel: false }), later)).toBe(false)
    expect(shipmentSettling(row({ status: 'pending', hasLabel: false }), later)).toBe(false)
    // Waiting five minutes for the next attempt.
    expect(shipmentSettling(row({ status: 'requested', hasLabel: false, mayExistAtCarrier: true }), soon)).toBe(false)
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
    expect(pickupSettling({ phase: 'new' }, [{ handedOverAt: taken }], new Date('2026-10-10T10:00:20Z'))).toBe(false)
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
