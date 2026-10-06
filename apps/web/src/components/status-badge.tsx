import type { OrderPhase } from '@hanza/core'
import type { ConnectionHealth, OrderStatusColor } from '@hanza/db'
import { useT } from '@/i18n/use-t'
import { healthLabel, orderPhaseLabel, orderStatusName } from '@/lib/labels'

const base = 'inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium'

const phaseTone: Record<OrderPhase, string> = {
  new: 'border-sky-300 bg-sky-50 text-sky-900',
  processing: 'border-amber-300 bg-amber-50 text-amber-900',
  shipped: 'border-green-300 bg-green-50 text-green-900',
  cancelled: 'border-line bg-canvas text-muted',
}

// Whole class names, so Tailwind sees every one of them.
const colorTone: Record<OrderStatusColor, string> = {
  gray: 'border-gray-300 bg-gray-50 text-gray-900',
  blue: 'border-blue-300 bg-blue-50 text-blue-900',
  teal: 'border-teal-300 bg-teal-50 text-teal-900',
  green: 'border-green-300 bg-green-50 text-green-900',
  amber: 'border-amber-300 bg-amber-50 text-amber-900',
  orange: 'border-orange-300 bg-orange-50 text-orange-900',
  red: 'border-red-300 bg-red-50 text-red-900',
  violet: 'border-violet-300 bg-violet-50 text-violet-900',
}

const healthTone: Record<ConnectionHealth, string> = {
  unknown: 'border-line bg-canvas text-muted',
  ok: 'border-green-300 bg-green-50 text-green-900',
  failing: 'border-red-300 bg-red-50 text-red-900',
  auth_expired: 'border-amber-300 bg-amber-50 text-amber-900',
}

// The meaning is always in the text; colour only reinforces it.
export function OrderStatusBadge({ status }: { status: { name: string | null; phase: OrderPhase; color: OrderStatusColor | null } }) {
  const t = useT()
  const tone = status.color ? colorTone[status.color] : phaseTone[status.phase]
  return (
    <span className={`${base} ${tone}`} title={orderPhaseLabel(t, status.phase)}>
      {orderStatusName(t, status)}
    </span>
  )
}

export function HealthBadge({ health }: { health: ConnectionHealth }) {
  const t = useT()
  return <span className={`${base} ${healthTone[health]}`}>{healthLabel(t, health)}</span>
}

/** A neutral tag, such as "Default" or "Inactive" on a Warehouse. */
export function TagBadge({ label }: { label: string }) {
  return <span className={`${base} border-line bg-canvas text-muted`}>{label}</span>
}

export function AwaitingPaymentBadge() {
  const t = useT()
  return <span className={`${base} border-amber-300 bg-amber-50 text-amber-900`}>{t('orders.awaitingPayment')}</span>
}

export function AttentionBadge({ label }: { label?: string }) {
  const t = useT()
  return <span className={`${base} border-red-300 bg-red-50 text-red-900`}>{label ?? t('orders.needsAttention')}</span>
}
