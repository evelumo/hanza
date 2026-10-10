import {
  defineConnector,
  TransientError,
  type AnyConnectorDefinition,
  type ShipmentLabel,
  type ShipmentRequest,
  type ShipmentState,
  type ShipmentStatus,
} from '@hanza/connector-sdk'
import { z } from 'zod'

export interface TestCarrierShipment extends ShipmentState {
  reference: string
}

type Capability = 'create' | 'track' | 'label' | 'cancel'

/** An in-memory Carrier a test scripts: what it holds, what it was asked, and how its next answers go wrong. */
export interface TestCarrier {
  connector: AnyConnectorDefinition
  /** What the Carrier holds, by its own id. Change a status with `advance`. */
  shipments: Map<string, TestCarrierShipment>
  /** Every call it received, in order; `create` holds the requests, which carry Buyer data. */
  calls: { create: ShipmentRequest[]; track: string[][]; label: string[]; cancel: string[] }
  /** While set, every call of that capability throws it before doing anything. */
  failures: Partial<Record<Capability, Error>>
  /** While set, `create` refuses every request for good with this code. */
  rejectWith: string | null
  /** The next this many `create` calls make (or find) the Shipment and then lose the answer. */
  loseAnswers: number
  /** While set, `cancel` refuses with this code. */
  cancelRefusal: string | null
  /** Carrier ids left out of `track` answers: nothing new about them. */
  silent: Set<string>
  /** States added to every `track` answer whatever was asked: a connector answering for another Shipment. */
  unasked: ShipmentState[]
  label: ShipmentLabel
  /** Runs inside `create`, after the request arrived and before the Carrier acts. */
  duringCreate: (() => Promise<void>) | null
  /** Moves a Shipment to `status`, giving it a tracking number once it is confirmed. */
  advance(externalId: string, status: ShipmentStatus, carrierStatus?: string | null): void
  /** The Carrier's Shipment made for a Hanza Shipment id. */
  byReference(reference: string): TestCarrierShipment | undefined
}

export const TEST_CARRIER_SERVICES = {
  locker: 'test_locker',
  courier: 'test_courier',
} as const

/**
 * A Carrier for tests, with a locker service (pickup point, presets, cash on delivery) and a courier service (address,
 * dimensions, no cash on delivery). `create` is repeatable by `reference`, as the SDK demands. `cancel: false` leaves
 * out the optional `shipments.cancel`.
 */
export function createTestCarrier(options: { id?: string; cancel?: boolean } = {}): TestCarrier {
  const shipments = new Map<string, TestCarrierShipment>()
  const failIf = (capability: Capability) => {
    const failure = carrier.failures[capability]
    if (failure) throw failure
  }
  const stateOf = ({ reference: _, ...state }: TestCarrierShipment): ShipmentState => state

  const carrier: TestCarrier = {
    shipments,
    calls: { create: [], track: [], label: [], cancel: [] },
    failures: {},
    rejectWith: null,
    loseAnswers: 0,
    cancelRefusal: null,
    silent: new Set(),
    unasked: [],
    label: { contentType: 'application/pdf', data: new TextEncoder().encode('%PDF-1.7 label of a test parcel') },
    duringCreate: null,
    advance(externalId, status, carrierStatus = null) {
      const shipment = shipments.get(externalId)
      if (!shipment) throw new Error(`The test Carrier has no Shipment ${externalId}`)
      shipment.status = status
      shipment.carrierStatus = carrierStatus
      if (status !== 'pending') shipment.trackingNumber ??= `TRACK-${externalId}`
    },
    byReference(reference) {
      return [...shipments.values()].find((shipment) => shipment.reference === reference)
    },
    connector: defineConnector({
      id: options.id ?? 'test-carrier',
      name: 'Test carrier',
      kind: 'courier',
      auth: { type: 'none' },
      configSchema: z.object({}),
      credentialsSchema: z.object({}),
      shipping: {
        services: [
          {
            id: TEST_CARRIER_SERVICES.locker,
            name: 'Test locker',
            destination: 'pickup_point',
            parcel: { type: 'presets', presets: [{ id: 'small', name: 'Small' }, { id: 'large', name: 'Large' }] },
            cashOnDelivery: true,
          },
          { id: TEST_CARRIER_SERVICES.courier, name: 'Test courier', destination: 'address', parcel: { type: 'dimensions' }, cashOnDelivery: false },
        ],
      },
      capabilities: {
        async 'shipments.create'(_ctx, request) {
          carrier.calls.create.push(request)
          failIf('create')
          await carrier.duringCreate?.()
          if (carrier.rejectWith !== null) return { outcome: 'rejected', code: carrier.rejectWith }
          let shipment = carrier.byReference(request.reference)
          if (!shipment) {
            shipment = { externalId: `carrier-${shipments.size + 1}`, reference: request.reference, status: 'pending', trackingNumber: null, carrierStatus: null }
            shipments.set(shipment.externalId, shipment)
          }
          if (carrier.loseAnswers > 0) {
            carrier.loseAnswers--
            throw new TransientError('The connection dropped before the Carrier\'s answer arrived')
          }
          return { outcome: 'created', ...stateOf(shipment) }
        },
        async 'shipments.track'(_ctx, externalIds) {
          carrier.calls.track.push(externalIds)
          failIf('track')
          const known = externalIds.flatMap((externalId) => {
            const shipment = shipments.get(externalId)
            return shipment && !carrier.silent.has(externalId) ? [stateOf(shipment)] : []
          })
          return [...known, ...carrier.unasked]
        },
        async 'shipments.label'(_ctx, { externalId }) {
          carrier.calls.label.push(externalId)
          failIf('label')
          return carrier.label
        },
        ...(options.cancel === false
          ? {}
          : {
              async 'shipments.cancel'(_ctx: unknown, { externalId }: { externalId: string }) {
                carrier.calls.cancel.push(externalId)
                failIf('cancel')
                if (carrier.cancelRefusal !== null) return { outcome: 'refused' as const, code: carrier.cancelRefusal }
                const shipment = shipments.get(externalId)
                if (shipment) shipment.status = 'cancelled'
                return { outcome: 'cancelled' as const }
              },
            }),
      },
    }),
  }
  return carrier
}
