import type { OrderPhase } from '@hanza/core'
import { LinkList, LinkRow, RowCount } from '@/components/link-list'
import { Section } from '@/components/section'
import { AwaitingPaymentBadge, OrderStatusBadge } from '@/components/status-badge'
import { TextLink } from '@/components/text-link'
import { useT } from '@/i18n/use-t'
import type { Formatters } from '@/lib/format'
import { pageHref } from '@/lib/pagination'

/**
 * Every Order is in exactly one phase, so the four rows add up to all Orders. Awaiting payment is a mark on
 * some of the open ones and nothing a person acts on (ADR 0015), which is why it is here and not under
 * "Needs attention".
 */
export function PhasesSection({
  counts,
  awaitingPayment,
  format,
}: {
  counts: Array<{ phase: OrderPhase; count: number }>
  awaitingPayment: number
  format: Formatters
}) {
  const t = useT()
  return (
    <Section
      title={t('dashboard.phases.title')}
      actions={
        <TextLink href="/orders" className="text-meta">
          {t('dashboard.phases.all')}
        </TextLink>
      }
    >
      <LinkList>
        {counts.map(({ phase, count }) => (
          <LinkRow
            key={phase}
            href={pageHref('/orders', { phase }, 1)}
            className="py-2.5"
            // The badge an Order of this phase carries in the Orders list, so the row is recognised by it.
            title={
              <span className="flex">
                <OrderStatusBadge status={{ name: null, phase, color: null }} />
              </span>
            }
            trailing={<RowCount value={count}>{format.number(count)}</RowCount>}
          />
        ))}
        {awaitingPayment > 0 ? (
          <LinkRow
            href={pageHref('/orders', { payment: 'awaiting' }, 1)}
            title={
              <span className="flex">
                <AwaitingPaymentBadge />
              </span>
            }
            detail={t('dashboard.phases.awaitingPaymentHint')}
            trailing={<RowCount value={awaitingPayment}>{format.number(awaitingPayment)}</RowCount>}
          />
        ) : null}
      </LinkList>
    </Section>
  )
}
