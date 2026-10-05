import { moneySchema, type Money } from '@hanza/connector-sdk'
import { hasLabel, labelOrRaw } from './labels'
import type { Translator } from '@/i18n/types'

type Payload = Record<string, unknown>

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const count = (value: unknown): number | null => (typeof value === 'number' ? value : null)

function arrow(from: string | null, to: string | null): string | null {
  return from !== null && to !== null ? `${from} → ${to}` : null
}

function nested(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Payload)[key] : undefined
}

type NumberFormat = (value: number) => string
type MoneyFormat = (money: Money) => string

export interface EventFormatters {
  number: NumberFormat
  money: MoneyFormat
}

// The payload is untrusted, so only a well-formed price is shown; null means "no price".
function priceText(t: Translator, money: MoneyFormat, value: unknown): string | null {
  if (value === null) return t('prices.none')
  const parsed = moneySchema.safeParse(value)
  return parsed.success ? money(parsed.data) : null
}

const formatted = (value: unknown, number: NumberFormat): string | null => {
  const n = count(value)
  return n === null ? null : number(n)
}

// Payloads are untrusted JSON, and a status or reason this build does not know yet is shown as it is.
function detail(t: Translator, format: EventFormatters, type: string, payload: Payload): string | null {
  const { number } = format
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
    case 'product.price_changed':
    case 'offer.price_changed':
      return arrow(priceText(t, format.money, payload.from), priceText(t, format.money, payload.to))
    case 'order.status_changed':
      return arrow(statusLabel(t, text(payload.from)), statusLabel(t, text(payload.to)))
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

const statusLabel = (t: Translator, value: string | null) => (value === null ? null : labelOrRaw(t, 'labels.orderStatus', value))
const healthLabel = (t: Translator, value: string | null) => (value === null ? null : labelOrRaw(t, 'labels.health', value))

/** Event types have dots, which message keys cannot contain: `order.status_changed` is `order_status_changed`. */
const titleKey = (type: string) => type.replaceAll('.', '_')

/**
 * One-liner for an Event in the request's language; payloads are untrusted JSON, so every field is type-checked.
 * `format` holds the locale's number and money formatters (`getFormatters()`).
 */
export function describeEvent(
  type: string,
  payload: Payload,
  t: Translator,
  format: EventFormatters,
): { title: string; detail: string | null } {
  const result = detail(t, format, type, payload)
  const title = hasLabel('events.title', titleKey(type)) ? labelOrRaw(t, 'events.title', titleKey(type)) : type
  return { title, detail: result && result.trim() !== '' ? result : null }
}
