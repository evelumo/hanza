import { listConnections, listEvents, listOffers, listOrders, ORDER_PHASES, type OrderPhase } from '@hanza/core'
import type { Metadata } from 'next'
import { EmptyState } from '@/components/empty-state'
import { EventTimeline } from '@/components/event-timeline'
import { PageHeader } from '@/components/page-header'
import { Page } from '@/components/page-layout'
import { Section } from '@/components/section'
import { getT } from '@/i18n/server'
import { getContext } from '@/lib/context'
import { getFormatters } from '@/lib/formatters'
import { requireTenant } from '@/lib/session'
import { AttentionSection } from './attention-section'
import { ConnectionsSection } from './connections-section'
import { loadEventIdentifiers } from './event-subjects'
import { attentionItems, setupSteps, summarizeAttention } from './overview'
import { PhasesSection } from './phases-section'
import { SetupSection } from './setup-section'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('dashboard.title') }
}

export default async function DashboardPage() {
  const { organizationId } = await requireTenant()
  const [t, format] = await Promise.all([getT(), getFormatters()])
  const ctx = getContext()

  // The list services return the total of their filter. Asking for a page of no rows makes each call a count
  // that cannot disagree with the list its row links to.
  const noRows = { skip: 0, take: 0 }
  const countOrders = async (filter: { phase?: OrderPhase; awaitingPayment?: boolean }) =>
    (await listOrders(ctx, organizationId, { ...filter, ...noRows })).total
  const countOffers = async (linked: boolean) => (await listOffers(ctx, organizationId, { linked, ...noRows })).total

  const [connections, events, phaseCounts, awaitingPayment, attentionGroups, unlinkedOffers, linkedOffers, stockRows] = await Promise.all([
    listConnections(ctx, organizationId),
    listEvents(ctx, organizationId, null, 10),
    Promise.all(ORDER_PHASES.map(async (phase) => ({ phase, count: await countOrders({ phase }) }))),
    countOrders({ awaitingPayment: true }),
    // One statement for the Orders that need attention (the filter of `/orders?attention=1`) and their
    // reasons, so the total and the breakdown under it describe the same Orders.
    ctx.db.order.groupBy({
      by: ['attentionReasons'],
      where: { organizationId, attentionReasons: { isEmpty: false } },
      _count: { _all: true },
    }),
    countOffers(false),
    countOffers(true),
    ctx.db.stock.count({ where: { organizationId, units: { not: 0 } } }),
  ])

  const identifiers = await loadEventIdentifiers(ctx, organizationId, events)

  const steps = setupSteps({ connections: connections.length, linkedOffers, stockRows })
  const attention = attentionItems({
    connections,
    orders: summarizeAttention(attentionGroups.map((group) => ({ reasons: group.attentionReasons, orders: group._count._all }))),
    unlinkedOffers,
  })

  return (
    <Page>
      <PageHeader title={t('dashboard.title')} description={t('dashboard.intro')} />

      {/* What waits for a person leads the page; the first-run list follows it and goes away once it is done. */}
      <AttentionSection items={attention} />

      {steps ? <SetupSection steps={steps} /> : null}

      {/* Side by side once the page (not the window) is wide enough, like the columns of a detail page. */}
      <div className="grid gap-5 @3xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <PhasesSection counts={phaseCounts} awaitingPayment={awaitingPayment} format={format} />
        <ConnectionsSection connections={connections} format={format} />
      </div>

      <Section title={t('dashboard.eventsTitle')} description={t('dashboard.eventsDescription')}>
        {events.length === 0 ? <EmptyState>{t('dashboard.eventsEmpty')}</EmptyState> : <EventTimeline events={events} format={format} identifiers={identifiers} />}
      </Section>
    </Page>
  )
}
