import type { ChannelReportedPhase, OrderPhase } from '@hanza/core'
import type { AttentionReason, ChannelFactType, ConnectionHealth, OrderStatusColor, PaymentMethod, ShipmentStatus, SyncErrorKind, SyncStream } from '@hanza/db'
import en from '../../messages/en.json'
import type { MessageKey, Translator } from '@/i18n/types'

// Each lookup builds its key from the value, so a status the catalogue lacks does not compile.
export const orderPhaseLabel = (t: Translator, phase: OrderPhase) => t(`labels.orderPhase.${phase}`)
export const statusColorLabel = (t: Translator, color: OrderStatusColor) => t(`labels.statusColor.${color}`)
export const reportedPhaseLabel = (t: Translator, phase: ChannelReportedPhase) => t(`labels.reportedPhase.${phase}`)
/** An Order status as people see it: its name, or the phase's name in their language while it has none. */
export const orderStatusName = (t: Translator, status: { name: string | null; phase: OrderPhase }) => status.name ?? orderPhaseLabel(t, status.phase)
export const attentionReasonLabel = (t: Translator, reason: AttentionReason) => t(`labels.attentionReason.${reason}`)
export const healthLabel = (t: Translator, health: ConnectionHealth) => t(`labels.health.${health}`)
export const streamLabel = (t: Translator, stream: SyncStream) => t(`labels.syncStream.${stream}`)
export const paymentLabel = (t: Translator, payment: PaymentMethod) => t(`labels.payment.${payment}`)
export const factLabel = (t: Translator, fact: ChannelFactType) => t(`labels.channelFact.${fact}`)
export const reservationLabel = (t: Translator, status: 'open' | 'released' | 'consumed') => t(`labels.reservation.${status}`)
export const syncErrorLabel = (t: Translator, kind: SyncErrorKind) => t(`labels.syncError.${kind}`)
export const shipmentStatusLabel = (t: Translator, status: ShipmentStatus) => t(`labels.shipmentStatus.${status}`)

type OpenGroup =
  | 'labels.connectorKind'
  | 'labels.orderPhase'
  | 'labels.health'
  | 'labels.attentionReason'
  | 'labels.channelFact'
  | 'labels.erasureCause'
  | 'labels.shipmentStatus'
  | 'labels.shipmentFailure'
  | 'sync.result'
  | 'events.title'

function groupOf(group: OpenGroup): Record<string, unknown> {
  let node: unknown = en
  for (const part of group.split('.')) node = (node as Record<string, unknown>)[part]
  return node as Record<string, unknown>
}

export function hasLabel(group: OpenGroup, value: string): boolean {
  return Object.hasOwn(groupOf(group), value)
}

/** Lookup that never throws on a value this build does not know yet: the raw value is shown instead. */
export function labelOrRaw(t: Translator, group: OpenGroup, value: string): string {
  return hasLabel(group, value) ? t(`${group}.${value}` as MessageKey) : value
}
