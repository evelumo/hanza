import { orderPhaseSchema, ORDER_PHASES, type OrderPhase } from '@hanza/connector-sdk'
import type { OrderPhase as DbOrderPhase } from '@hanza/db'

// The fixed Order phases the core reasons about (ADR 0018) are the SDK's: connectors translate Channel statuses to and from them.
export { ORDER_PHASES, orderPhaseSchema, type OrderPhase }

/** The phases a Channel reports, and so the ones a Status mapping covers: an import (new) and its facts. */
export const CHANNEL_REPORTED_PHASES = ['new', 'shipped', 'cancelled'] as const satisfies readonly OrderPhase[]
export type ChannelReportedPhase = (typeof CHANNEL_REPORTED_PHASES)[number]

// The database enum and the SDK list must stay the same set: a value added to one only fails to compile here.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const samePhases: Same<OrderPhase, DbOrderPhase> = true
void samePhases
