import {
  PermanentError,
  TransientError,
  defineConnector,
  isShipmentHandedOver,
  type CapabilityContext,
  type ConnectorDefinition,
  type ShipmentCancelResult,
  type ShipmentCreateResult,
  type ShipmentRequest,
  type ShipmentState,
  type ShipmentStatus,
  type ShippingService,
} from '@hanza/connector-sdk'
import { z } from 'zod'
import { fakeLabelPdf } from './courier-label'

/** The statuses a Shipment of the fake Carrier moves through, one step for each `shipments.track`. */
export const FAKE_COURIER_PROGRESSION = ['pending', 'ready', 'in_transit', 'delivered'] as const satisfies readonly ShipmentStatus[]

/** The fake Carrier's own status code for each status it reports. */
export const FAKE_COURIER_CARRIER_STATUS = {
  pending: 'created',
  ready: 'confirmed',
  in_transit: 'collected',
  delivered: 'delivered',
  cancelled: 'cancelled',
} as const

/** The codes `shipments.create` refuses a request with. */
export const FAKE_COURIER_PICKUP_POINT_UNKNOWN = 'pickup_point_unknown'
export const FAKE_COURIER_PHONE_MISSING = 'receiver_phone_missing'
/** The code `shipments.cancel` refuses with once the Carrier has the parcel. */
export const FAKE_COURIER_TOO_LATE = 'too_late'
/** The code `shipments.cancel` refuses with for a Shipment this Carrier account does not have. */
export const FAKE_COURIER_SHIPMENT_UNKNOWN = 'shipment_unknown'

export const fakeCourierConfigSchema = z.object({
  account: z
    .string()
    .min(1)
    .max(100)
    .default('default')
    .describe('Carrier account (Connections with the same account see the same Shipments)'),
  rejectPickupPoints: z.string().max(1000).default('').describe('Pickup points the Carrier refuses (comma-separated ids)'),
  stuckAt: z.enum(['none', 'pending', 'ready', 'in_transit']).default('none').describe('Hold every Shipment at this status'),
})

export const fakeCourierCredentialsSchema = z.object({})

export type FakeCourierContext = CapabilityContext<z.output<typeof fakeCourierConfigSchema>, z.output<typeof fakeCourierCredentialsSchema>>

/** The services the fake Carrier offers: ids and parcel presets are stored with every Shipment, so never rename them. */
export const fakeCourierServices: ShippingService[] = [
  {
    id: 'locker',
    name: 'Fake locker',
    destination: 'pickup_point',
    parcel: {
      type: 'presets',
      presets: [
        { id: 'small', name: 'Small (up to 8 x 38 x 64 cm)' },
        { id: 'medium', name: 'Medium (up to 19 x 38 x 64 cm)' },
        { id: 'large', name: 'Large (up to 41 x 38 x 64 cm)' },
      ],
    },
    cashOnDelivery: true,
  },
  { id: 'courier', name: 'Fake courier', destination: 'address', parcel: { type: 'dimensions' }, cashOnDelivery: true },
]

/** A Shipment as the fake Carrier keeps it. */
export interface FakeCourierShipment {
  /** The Carrier account (config `account`) that made it; no other account sees it. */
  account: string
  externalId: string
  /** Hanza's Shipment id from the request: the key of a repeated create. */
  reference: string
  request: ShipmentRequest
  status: ShipmentStatus
  trackingNumber: string
}

/** What the fake Carrier remembers; owned by `createFakeCourier`. */
export interface FakeCourierState {
  /** Every Shipment made, oldest first. */
  shipments: FakeCourierShipment[]
  /** The request of every `shipments.create` call, repeated and refused ones included. */
  creates: ShipmentRequest[]
  /** The ids of every `shipments.track` call (an empty list is not a call). */
  tracks: string[][]
  /** The id of every `shipments.label` call, also the ones that failed because the Label was not ready. */
  labels: string[]
  /** The id of every `shipments.cancel` call. */
  cancels: string[]
  /** The next Shipment gets this number in its id and tracking number. */
  nextNumber: number
}

function carrierStatusOf(status: ShipmentStatus): string | null {
  return status in FAKE_COURIER_CARRIER_STATUS ? FAKE_COURIER_CARRIER_STATUS[status as keyof typeof FAKE_COURIER_CARRIER_STATUS] : null
}

function stateOf(shipment: FakeCourierShipment): ShipmentState {
  return {
    externalId: shipment.externalId,
    status: shipment.status,
    trackingNumber: shipment.trackingNumber,
    carrierStatus: carrierStatusOf(shipment.status),
  }
}

function listed(value: string): string[] {
  return value.split(',').map((item) => item.trim())
}

export type FakeCourierConnector = ConnectorDefinition<typeof fakeCourierConfigSchema, typeof fakeCourierCredentialsSchema>

export function createFakeCourierConnector(state: FakeCourierState, options: { id?: string } = {}): FakeCourierConnector {
  const find = (ctx: FakeCourierContext, externalId: string) =>
    state.shipments.find((shipment) => shipment.account === ctx.config.account && shipment.externalId === externalId)

  return defineConnector({
    id: options.id ?? 'fake-courier',
    name: 'Test courier',
    kind: 'courier',
    auth: { type: 'none' },
    configSchema: fakeCourierConfigSchema,
    credentialsSchema: fakeCourierCredentialsSchema,
    shipping: { services: fakeCourierServices },
    capabilities: {
      async 'shipments.create'(ctx, request): Promise<ShipmentCreateResult> {
        state.creates.push(structuredClone(request))
        const known = state.shipments.find((shipment) => shipment.account === ctx.config.account && shipment.reference === request.reference)
        if (known) return { outcome: 'created', ...stateOf(known) }
        if (request.destination.type === 'pickup_point') {
          if (listed(ctx.config.rejectPickupPoints).includes(request.destination.pointId)) {
            return { outcome: 'rejected', code: FAKE_COURIER_PICKUP_POINT_UNKNOWN }
          }
          if (request.receiver.phone === null) return { outcome: 'rejected', code: FAKE_COURIER_PHONE_MISSING }
        }
        const number = String(state.nextNumber++).padStart(6, '0')
        const shipment: FakeCourierShipment = {
          account: ctx.config.account,
          externalId: `fake-shipment-${number}`,
          reference: request.reference,
          request: structuredClone(request),
          status: 'pending',
          trackingNumber: `FAKE${number}`,
        }
        state.shipments.push(shipment)
        return { outcome: 'created', ...stateOf(shipment) }
      },
      async 'shipments.track'(ctx, externalIds): Promise<ShipmentState[]> {
        if (externalIds.length === 0) return []
        state.tracks.push([...externalIds])
        const states: ShipmentState[] = []
        for (const externalId of new Set(externalIds)) {
          const shipment = find(ctx, externalId)
          if (!shipment) continue
          const step = FAKE_COURIER_PROGRESSION.indexOf(shipment.status as (typeof FAKE_COURIER_PROGRESSION)[number])
          // A cancelled Shipment is in no step; one at `stuckAt` stays there.
          if (step !== -1 && step < FAKE_COURIER_PROGRESSION.length - 1 && shipment.status !== ctx.config.stuckAt) {
            shipment.status = FAKE_COURIER_PROGRESSION[step + 1]!
          }
          states.push(stateOf(shipment))
        }
        return states
      },
      async 'shipments.label'(ctx, { externalId }) {
        state.labels.push(externalId)
        const shipment = find(ctx, externalId)
        if (!shipment) throw new PermanentError('The Carrier does not know this Shipment')
        if (shipment.status === 'pending') throw new TransientError('The Carrier has no Label yet')
        // No Buyer data: the tracking number is all a Label of the fake Carrier says about the parcel.
        return { contentType: 'application/pdf', data: fakeLabelPdf(['FAKE LABEL', `Tracking ${shipment.trackingNumber}`]) }
      },
      async 'shipments.cancel'(ctx, { externalId }): Promise<ShipmentCancelResult> {
        state.cancels.push(externalId)
        const shipment = find(ctx, externalId)
        // Not knowing a Shipment says nothing about what became of the parcel, so it is never "cancelled".
        if (!shipment) return { outcome: 'refused', code: FAKE_COURIER_SHIPMENT_UNKNOWN }
        if (shipment.status === 'cancelled') return { outcome: 'cancelled' }
        if (isShipmentHandedOver(shipment.status)) return { outcome: 'refused', code: FAKE_COURIER_TOO_LATE }
        shipment.status = 'cancelled'
        return { outcome: 'cancelled' }
      },
    },
  })
}

export interface FakeCourier {
  connector: FakeCourierConnector
  /** Every Shipment made, oldest first, as the Carrier keeps it (Buyer data of the request included: test data only). */
  readonly shipments: FakeCourierShipment[]
  /** The request of every `shipments.create` call, in order. */
  readonly creates: ShipmentRequest[]
  /** The ids of every `shipments.track` call, in order. */
  readonly tracks: string[][]
  /** The id of every `shipments.label` call, in order. */
  readonly labels: string[]
  /** The id of every `shipments.cancel` call, in order. */
  readonly cancels: string[]
  /** Back to an empty Carrier: no Shipments, no recorded calls, numbering from 1. */
  reset(): void
}

export interface FakeCourierOptions {
  /** Other than "fake-courier" lets a test register several independent fake Carriers side by side. */
  id?: string
}

export function createFakeCourier(options: FakeCourierOptions = {}): FakeCourier {
  // Like the fake Channel, this keeps its data in memory. A real connector holds no state between calls: a Shipment
  // lives at the Carrier and the connector finds it again by its `reference` or its id.
  const state: FakeCourierState = { shipments: [], creates: [], tracks: [], labels: [], cancels: [], nextNumber: 1 }
  return {
    connector: createFakeCourierConnector(state, options),
    shipments: state.shipments,
    creates: state.creates,
    tracks: state.tracks,
    labels: state.labels,
    cancels: state.cancels,
    // The arrays are emptied in place so references held by a test stay valid.
    reset() {
      state.shipments.length = 0
      state.creates.length = 0
      state.tracks.length = 0
      state.labels.length = 0
      state.cancels.length = 0
      state.nextNumber = 1
    },
  }
}

/** Default instance, used by the connector registry. */
export const fakeCourier: FakeCourier = createFakeCourier()
export const fakeCourierConnector = fakeCourier.connector
