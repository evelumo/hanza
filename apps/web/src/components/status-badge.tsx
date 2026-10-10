import type { OfferPublication, OrderPhase } from '@hanza/core'
import type { ConnectionHealth, OrderStatusColor } from '@hanza/db'
import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleSlash,
  Clock,
  KeyRound,
  OctagonAlert,
  type LucideIcon,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { useT } from '@/i18n/use-t'
import { healthLabel, orderPhaseLabel, orderStatusName } from '@/lib/labels'
import { publicationLabel } from '@/lib/offer-push-status'
import type { Tone } from './tone'

// Whole class names, so Tailwind sees every one of them.
const colorClass: Record<OrderStatusColor, string> = {
  gray: 'border-status-gray-border bg-status-gray-subtle text-status-gray',
  blue: 'border-status-blue-border bg-status-blue-subtle text-status-blue',
  teal: 'border-status-teal-border bg-status-teal-subtle text-status-teal',
  green: 'border-status-green-border bg-status-green-subtle text-status-green',
  amber: 'border-status-amber-border bg-status-amber-subtle text-status-amber',
  orange: 'border-status-orange-border bg-status-orange-subtle text-status-orange',
  red: 'border-status-red-border bg-status-red-subtle text-status-red',
  violet: 'border-status-violet-border bg-status-violet-subtle text-status-violet',
}

/** The colour of a status that has none of its own. */
const phaseColor: Record<OrderPhase, OrderStatusColor> = {
  new: 'blue',
  processing: 'amber',
  shipped: 'green',
  cancelled: 'gray',
}

// The colour is the organization's label; the shape says which phase the status belongs to, whatever its colour.
const phaseIcon: Record<OrderPhase, LucideIcon> = {
  new: Circle,
  processing: CircleDashed,
  shipped: CircleCheck,
  cancelled: CircleSlash,
}

const healthTone: Record<ConnectionHealth, { tone: Tone; icon: LucideIcon }> = {
  unknown: { tone: 'neutral', icon: CircleHelp },
  ok: { tone: 'success', icon: CircleCheck },
  failing: { tone: 'critical', icon: OctagonAlert },
  auth_expired: { tone: 'warning', icon: KeyRound },
}

// Only an Offer that is for sale stands out; a draft, an ended one and one the Channel never described differ by shape.
const publicationIcon: Record<OfferPublication['status'], LucideIcon> = {
  active: CircleCheck,
  inactive: CircleDashed,
  ended: CircleSlash,
}

export function OrderStatusBadge({ status }: { status: { name: string | null; phase: OrderPhase; color: OrderStatusColor | null } }) {
  const t = useT()
  return (
    <Badge icon={phaseIcon[status.phase]} className={colorClass[status.color ?? phaseColor[status.phase]]} title={orderPhaseLabel(t, status.phase)}>
      {orderStatusName(t, status)}
    </Badge>
  )
}

export function HealthBadge({ health }: { health: ConnectionHealth }) {
  const t = useT()
  const { tone, icon } = healthTone[health]
  return (
    <Badge tone={tone} icon={icon}>
      {healthLabel(t, health)}
    </Badge>
  )
}

/** An Offer's publication on its Channel. */
export function PublicationBadge({ publication }: { publication: OfferPublication | null }) {
  const t = useT()
  return (
    <Badge tone={publication?.status === 'active' ? 'success' : 'neutral'} icon={publication ? publicationIcon[publication.status] : CircleHelp}>
      {publicationLabel(t, publication)}
    </Badge>
  )
}

/** A tag such as "Default" or "Inactive" on a Warehouse: neutral unless a tone (with its icon) says more. */
export function TagBadge({ label, tone = 'neutral' }: { label: string; tone?: Tone }) {
  return <Badge tone={tone}>{label}</Badge>
}

export function AwaitingPaymentBadge() {
  const t = useT()
  return (
    <Badge tone="warning" icon={Clock}>
      {t('orders.awaitingPayment')}
    </Badge>
  )
}

/** Something a person has to act on: an Order that needs attention, an unmatched line, a Shortage. */
export function AttentionBadge({ label }: { label?: string }) {
  const t = useT()
  return (
    <Badge tone="attention" icon={CircleAlert}>
      {label ?? t('orders.needsAttention')}
    </Badge>
  )
}
