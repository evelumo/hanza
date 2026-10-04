import type { OrderStatus } from '@hanza/connector-sdk'
import type { ConnectionHealth } from '@hanza/db'
import { healthLabels, orderStatusLabels } from '@/lib/labels'

const base = 'inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium'

const statusTone: Record<OrderStatus, string> = {
  new: 'border-sky-300 bg-sky-50 text-sky-900',
  processing: 'border-amber-300 bg-amber-50 text-amber-900',
  shipped: 'border-green-300 bg-green-50 text-green-900',
  cancelled: 'border-line bg-canvas text-muted',
}

const healthTone: Record<ConnectionHealth, string> = {
  unknown: 'border-line bg-canvas text-muted',
  ok: 'border-green-300 bg-green-50 text-green-900',
  failing: 'border-red-300 bg-red-50 text-red-900',
  auth_expired: 'border-amber-300 bg-amber-50 text-amber-900',
}

// The meaning is always in the text; colour only reinforces it.
export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return <span className={`${base} ${statusTone[status]}`}>{orderStatusLabels[status]}</span>
}

export function HealthBadge({ health }: { health: ConnectionHealth }) {
  return <span className={`${base} ${healthTone[health]}`}>{healthLabels[health]}</span>
}

export function AttentionBadge({ label = 'Wymaga uwagi' }: { label?: string }) {
  return <span className={`${base} border-red-300 bg-red-50 text-red-900`}>{label}</span>
}
