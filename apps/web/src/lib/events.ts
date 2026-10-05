import { hasLabel, labelOrRaw } from './labels'
import type { Translator } from '@/i18n/types'

type Payload = Record<string, unknown>

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const count = (value: unknown): number | null => (typeof value === 'number' ? value : null)

function arrow(from: string | null, to: string | null): string | null {
  return from !== null && to !== null ? `${from} → ${to}` : null
}

function nested(value: unknown, key: 'from' | 'to'): unknown {
  return typeof value === 'object' && value !== null ? (value as Payload)[key] : undefined
}

type NumberFormat = (value: number) => string

const formatted = (value: unknown, number: NumberFormat): string | null => {
  const n = count(value)
  return n === null ? null : number(n)
}

// Payloads are untrusted JSON, and a status or reason this build does not know yet is shown as it is.
function detail(t: Translator, number: NumberFormat, type: string, payload: Payload): string | null {
  switch (type) {
    case 'stock.set':
      return arrow(formatted(payload.from, number), formatted(payload.to, number))
    case 'stock.reserved':
    case 'stock.released':
    case 'stock.consumed': {
      const units = count(payload.units)
      return units ? t('common.units', { count: units }) : null
    }
    case 'product.updated':
      return arrow(text(nested(payload.name, 'from')), text(nested(payload.name, 'to')))
    case 'order.status_changed':
      return arrow(statusName(t, payload.fromStatus, text(payload.from)), statusName(t, payload.toStatus, text(payload.to)))
    case 'connection.status_mapping_changed': {
      const phase = text(payload.phase)
      const change = arrow(mappedName(t, payload.from, phase), mappedName(t, payload.to, phase))
      return phase && change ? `${labelOrRaw(t, 'labels.orderPhase', phase)}: ${change}` : change
    }
    case 'order.channel_fact_recorded':
      return labelOrRaw(t, 'labels.channelFact', text(payload.type) ?? '')
    case 'order.attention_raised':
    case 'order.attention_resolved': {
      const reasons = payload.reasons ?? payload.cleared
      return Array.isArray(reasons) ? reasons.map((reason) => labelOrRaw(t, 'labels.attentionReason', String(reason))).join(', ') : null
    }
    case 'order.imported': {
      const lines = count(payload.lineCount)
      return lines ? t('events.lines', { count: lines }) : null
    }
    case 'connection.health_changed':
      return arrow(healthLabel(t, text(payload.from)), healthLabel(t, text(payload.to)))
    default:
      return null
  }
}

const phaseLabel = (t: Translator, value: string | null) => (value === null ? null : labelOrRaw(t, 'labels.orderPhase', value))

/**
 * The status name kept in the Event (renaming the status later does not change it). An unnamed status (a default) is
 * shown as its phase, in the viewer's language: the snapshot's own phase, else the phase the Event names.
 */
function statusName(t: Translator, snapshot: unknown, phase: string | null): string | null {
  if (typeof snapshot !== 'object' || snapshot === null) return phaseLabel(t, phase)
  const { name, phase: own } = snapshot as Payload
  return text(name) ?? phaseLabel(t, text(own) ?? phase)
}

/** A Status mapping side: no status at all is "the phase default"; an unnamed status is shown as its phase. */
function mappedName(t: Translator, snapshot: unknown, phase: string | null): string {
  if (typeof snapshot !== 'object' || snapshot === null) return t('events.defaultStatus')
  return statusName(t, snapshot, phase) ?? t('events.defaultStatus')
}
const healthLabel = (t: Translator, value: string | null) => (value === null ? null : labelOrRaw(t, 'labels.health', value))

/** Event types have dots, which message keys cannot contain: `order.status_changed` is `order_status_changed`. */
const titleKey = (type: string) => type.replaceAll('.', '_')

/**
 * One-liner for an Event in the request's language; payloads are untrusted JSON, so every field is type-checked.
 * `number` is the locale's number formatter (`getFormatters().number`).
 */
export function describeEvent(
  type: string,
  payload: Payload,
  t: Translator,
  number: NumberFormat,
): { title: string; detail: string | null } {
  const result = detail(t, number, type, payload)
  const title = hasLabel('events.title', titleKey(type)) ? labelOrRaw(t, 'events.title', titleKey(type)) : type
  return { title, detail: result && result.trim() !== '' ? result : null }
}
