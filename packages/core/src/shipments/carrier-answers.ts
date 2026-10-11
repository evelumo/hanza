import {
  PermanentError,
  shipmentCancelResultSchema,
  shipmentCreateResultSchema,
  shipmentLabelSchema,
  shipmentStateSchema,
  type ShipmentCancelResult,
  type ShipmentCreateResult,
  type ShipmentLabel,
  type ShipmentState,
} from '@hanza/connector-sdk'
import { z } from 'zod'

// What a connector returns from the `shipments.*` capabilities is validated like any external data. Every failure is
// a `PermanentError` (a broken contract), so call these inside `runConnectorCall`.

const MAX_REPORTED_ISSUES = 5

function parse<T>(schema: z.ZodType<T>, raw: unknown, capability: string): T {
  const parsed = schema.safeParse(raw)
  if (parsed.success) return parsed.data
  // Paths and Zod's messages only: they name what is wrong, not the values.
  const issues = [...new Set(parsed.error.issues.map((issue) => `${issue.path.map(String).join('.') || 'result'}: ${issue.message}`))]
  throw new PermanentError(`${capability} returned a result that breaks the contract: ${issues.slice(0, MAX_REPORTED_ISSUES).join('; ')}`)
}

export function parseCreateResult(raw: unknown): ShipmentCreateResult {
  return parse(shipmentCreateResultSchema, raw, 'shipments.create')
}

/**
 * The states `shipments.track` returned, by the Carrier's id. A state for an id that was not asked about is dropped:
 * the SDK does not stop a connector from answering for another Shipment, and applying it would move a Shipment
 * nobody checked. A Shipment left out is unchanged; one answered twice takes the last answer.
 */
export function parseTrackedStates(raw: unknown, asked: string[]): Map<string, ShipmentState> {
  const wanted = new Set(asked)
  const states = new Map<string, ShipmentState>()
  for (const state of parse(z.array(shipmentStateSchema), raw, 'shipments.track')) {
    if (wanted.has(state.externalId)) states.set(state.externalId, state)
  }
  return states
}

export function parseLabel(raw: unknown): ShipmentLabel {
  return parse(shipmentLabelSchema, raw, 'shipments.label')
}

export function parseCancelResult(raw: unknown): ShipmentCancelResult {
  return parse(shipmentCancelResultSchema, raw, 'shipments.cancel')
}
