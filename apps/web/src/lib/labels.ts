import type { OrderStatus } from '@hanza/connector-sdk'
import type { AttentionReason, ChannelFactType, ConnectionHealth, PaymentMethod, SyncErrorKind, SyncStream } from '@hanza/db'
import en from '../../messages/en.json'
import type { MessageKey, Translator } from '@/i18n/types'

// Each lookup builds its key from the value, so a status the catalogue lacks does not compile.
export const orderStatusLabel = (t: Translator, status: OrderStatus) => t(`labels.orderStatus.${status}`)
export const attentionReasonLabel = (t: Translator, reason: AttentionReason) => t(`labels.attentionReason.${reason}`)
export const healthLabel = (t: Translator, health: ConnectionHealth) => t(`labels.health.${health}`)
export const streamLabel = (t: Translator, stream: SyncStream) => t(`labels.syncStream.${stream}`)
export const paymentLabel = (t: Translator, payment: PaymentMethod) => t(`labels.payment.${payment}`)
export const factLabel = (t: Translator, fact: ChannelFactType) => t(`labels.channelFact.${fact}`)
export const reservationLabel = (t: Translator, status: 'open' | 'released' | 'consumed') => t(`labels.reservation.${status}`)
export const syncErrorLabel = (t: Translator, kind: SyncErrorKind) => t(`labels.syncError.${kind}`)

type OpenGroup =
  | 'labels.connectorKind'
  | 'labels.orderStatus'
  | 'labels.health'
  | 'labels.attentionReason'
  | 'labels.channelFact'
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
