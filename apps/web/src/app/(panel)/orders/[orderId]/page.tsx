import { getOrder, listOrderShipments, listShippingConnections, listWarehouses, ORDER_PHASES, type OrderDetail, type OrderPhase } from '@hanza/core'
import type { AttentionReason } from '@hanza/db'
import { OctagonAlert } from 'lucide-react'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Fragment, type ReactNode } from 'react'
import { ActionForm } from '@/components/action-form'
import { DataTable, DataTableBody, DataTableCell, DataTableHead, DataTableHeader, DataTableMeta, DataTableMetaItem, DataTableRow } from '@/components/data-table'
import { DescriptionItem, DescriptionList } from '@/components/description-list'
import { EmptyState } from '@/components/empty-state'
import { EventTimeline } from '@/components/event-timeline'
import { ActionButton } from '@/components/form'
import { Identifier } from '@/components/identifier'
import { NoValue } from '@/components/no-value'
import { Notice } from '@/components/notice'
import { PageHeader } from '@/components/page-header'
import { Page, PageColumns } from '@/components/page-layout'
import { Section, SectionContent } from '@/components/section'
import { AttentionBadge, AwaitingPaymentBadge, OrderStatusBadge } from '@/components/status-badge'
import { orderNumberClass, TextLink } from '@/components/text-link'
import { Timeline, TimelineItem } from '@/components/timeline'
import { Alert } from '@/components/ui/alert'
import { getT } from '@/i18n/server'
import { getContext } from '@/lib/context'
import { getFormatters } from '@/lib/formatters'
import { attentionReasonLabel, factLabel, orderPhaseLabel, orderStatusName, paymentLabel, reservationLabel } from '@/lib/labels'
import { showsAwaitingPayment } from '@/lib/payment'
import { requireTenant } from '@/lib/session'
import { changeOrderStatusAction, resolveAttentionAction } from './actions'
import { AddressBlock } from './address-block'
import { LinkLineForm } from './link-line-form'
import { MoveReservationForm } from './move-reservation-form'
import { ShipmentsSection } from './shipments-section'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('orders.detail.title') }
}

const lineSku = (sku: string | null) => (sku ? <Identifier>{sku}</Identifier> : <NoValue />)

const NEXT_PHASE: Partial<Record<OrderPhase, OrderPhase>> = { new: 'processing', processing: 'shipped' }

export default async function OrderPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { organizationId } = await requireTenant()
  const [t, format] = await Promise.all([getT(), getFormatters()])
  const { orderId } = await params
  const ctx = getContext()
  const order = await getOrder(ctx, organizationId, orderId)
  if (!order) notFound()
  // Reservations move only while the Order is in an open phase (the core refuses it otherwise).
  const orderOpen = order.phase === 'new' || order.phase === 'processing'
  const nextPhase = NEXT_PHASE[order.phase]
  const [warehouses, nextDefault, shipments, shippingConnections] = await Promise.all([
    orderOpen ? listWarehouses(ctx, organizationId) : [],
    nextPhase ? ctx.db.orderStatus.findFirst({ where: { organizationId, phase: nextPhase, isDefault: true }, select: { id: true } }) : null,
    listOrderShipments(ctx, organizationId, order.id),
    // For the form of a new Shipment, and for what a Shipment's row says about the Connection it went through.
    listShippingConnections(ctx, organizationId),
  ])
  const activeWarehouses = warehouses.filter((warehouse) => warehouse.active).map(({ id, name }) => ({ id, name }))

  const unmatchedLines = order.lines.filter((line) => !line.productId).length
  const awaitingPayment = showsAwaitingPayment(order)
  const needsAttention = order.attentionReasons.length > 0
  const manualReasons = order.attentionReasons.filter((reason) => reason !== 'unmatched_line')
  // The page's one primary action: on to the next phase. An Order that may not go there (it waits for its
  // payment) and a closed one have none.
  const primaryStatus = order.allowedStatuses.find((status) => status.id === nextDefault?.id) ?? null
  const statusGroups = ORDER_PHASES.map((phase) => ({
    phase,
    statuses: order.allowedStatuses.filter((status) => status.phase === phase && status.id !== primaryStatus?.id),
  })).filter((group) => group.statuses.length > 0)

  const statusForm = (status: OrderDetail['allowedStatuses'][number], look: 'primary' | 'listed'): ReactNode => {
    // Only a change of phase takes goods off stock or releases them; a move within the phase is a label.
    const phaseChange = status.phase !== order.phase
    const cancels = phaseChange && status.phase === 'cancelled'
    return (
      <ActionForm
        // A new key after lines get linked drops the stale "link the lines first" error.
        key={`${status.id}:${unmatchedLines}`}
        action={changeOrderStatusAction}
        // In the header the answer of a refused change sits under the button, at the width of a sentence.
        className={look === 'primary' ? 'grid max-w-sm justify-items-end gap-2' : 'grid gap-2'}
        confirm={phaseChange && status.phase === 'shipped' ? t('orders.detail.confirmShipped') : cancels ? t('orders.detail.confirmCancelled') : undefined}
      >
        <input type="hidden" name="orderId" value={order.id} />
        <input type="hidden" name="statusId" value={status.id} />
        <ActionButton
          variant={look === 'primary' ? 'primary' : cancels ? 'danger' : 'secondary'}
          pendingLabel={t('common.saving')}
          className={look === 'primary' ? undefined : 'justify-self-start'}
        >
          {t('orders.detail.changeTo', { status: orderStatusName(t, status) })}
        </ActionButton>
      </ActionForm>
    )
  }

  // What each reason asks of a person, with the way there. Only from what this page has already loaded.
  const shortLines = order.lines.filter((line) => line.shortage && line.productId)
  const recovery: Record<AttentionReason, { hint: string; links: Array<{ href: string; label: ReactNode }> }> = {
    unmatched_line: { hint: t('orders.detail.attention.unmatched_line'), links: [{ href: '#lines', label: t('orders.detail.attention.toLines') }] },
    shortage: {
      hint: t('orders.detail.attention.shortage'),
      links: [
        ...new Map(
          shortLines.map((line) => [
            line.productId,
            {
              href: `/products/${line.productId}`,
              label: (
                <>
                  {t('orders.detail.attention.toProduct')} <Identifier wrap>{line.productSku}</Identifier>
                </>
              ),
            },
          ]),
        ).values(),
        { href: '#reservations', label: t('orders.detail.attention.toReservations') },
      ],
    },
    cancelled_while_processing: { hint: t('orders.detail.attention.cancelled_while_processing'), links: [] },
    channel_fact_conflict: {
      hint: t('orders.detail.attention.channel_fact_conflict'),
      links: [{ href: '#channel-changes', label: t('orders.detail.attention.toChannelChanges') }],
    },
    status_push_failed: {
      hint: t('orders.detail.attention.status_push_failed'),
      links: [{ href: `/connections/${order.connectionId}`, label: t('orders.detail.attention.toConnection', { connection: order.connectionName }) }],
    },
    shipment_conflict: { hint: t('orders.detail.attention.shipment_conflict'), links: [{ href: '#shipments', label: t('orders.detail.attention.toShipments') }] },
  }

  // The names this page already holds for what its history points at.
  const eventIdentifiers = {
    product: new Map(order.lines.flatMap((line) => (line.productId && line.productSku ? [[line.productId, line.productSku] as const] : []))),
    connection: new Map([
      [order.connectionId, order.connectionName],
      ...shipments.map((shipment) => [shipment.connectionId, shipment.connectionName] as const),
    ]),
    warehouse: new Map([
      ...activeWarehouses.map((warehouse) => [warehouse.id, warehouse.name] as const),
      ...order.lines.flatMap((line) => (line.reservationWarehouse ? [[line.reservationWarehouse.id, line.reservationWarehouse.name] as const] : [])),
    ]),
  }

  return (
    <Page>
      <PageHeader
        back={{ href: '/orders', label: t('orders.title') }}
        title={
          <>
            {t('orders.detail.title')} <span className={orderNumberClass}>{order.externalId}</span>
          </>
        }
        badges={
          <>
            <OrderStatusBadge status={order.status} />
            {awaitingPayment ? <AwaitingPaymentBadge /> : null}
            {needsAttention ? <AttentionBadge /> : null}
          </>
        }
        meta={
          <>
            {t('orders.detail.phaseLine', { phase: orderPhaseLabel(t, order.phase) })} ·{' '}
            {t('orders.detail.summary', {
              channel: order.connectionName,
              date: format.dateTime(order.placedAt),
              payment: paymentLabel(t, order.payment),
              total: format.money(order.total),
            })}
          </>
        }
        actions={primaryStatus ? statusForm(primaryStatus, 'primary') : undefined}
      />

      <PageColumns
        aside={
          <>
            <Section
              title={t('orders.detail.statusTitle')}
              description={t('orders.detail.statusDescription')}
              actions={<OrderStatusBadge status={order.status} />}
            >
              <SectionContent className="grid gap-3">
                {awaitingPayment ? (
                  <Notice tone="warning">
                    {order.phase === 'shipped' ? t('orders.detail.awaitingPaymentShippedHint') : t('orders.detail.awaitingPaymentHint')}
                  </Notice>
                ) : null}
                {statusGroups.length === 0 ? (
                  primaryStatus ? null : (
                    <p className="text-sm text-muted-foreground">{t('orders.detail.finalStatus', { status: orderStatusName(t, order.status) })}</p>
                  )
                ) : (
                  statusGroups.map((group) => {
                    // A heading that only repeats its one button ("Cancelled" over "Change to: Cancelled") is left out.
                    const named = group.statuses.length > 1 || group.statuses.some((status) => status.name !== null)
                    return (
                      // One form per row, so an error has the width of the card and not of its button.
                      <div key={group.phase} className="grid gap-2">
                        {named ? <h3 className="text-meta font-medium text-muted-foreground">{orderPhaseLabel(t, group.phase)}</h3> : null}
                        {group.statuses.map((status) => statusForm(status, 'listed'))}
                      </div>
                    )
                  })
                )}
              </SectionContent>
            </Section>

            <ShipmentsSection order={order} shipments={shipments} connections={shippingConnections} />

            <Section title={t('orders.detail.paymentTitle')} actions={awaitingPayment ? <AwaitingPaymentBadge /> : undefined}>
              <SectionContent className="py-2">
                <DescriptionList layout="inline">
                  <DescriptionItem term={t('orders.detail.paymentMethod')}>{paymentLabel(t, order.payment)}</DescriptionItem>
                  <DescriptionItem term={t('orders.columns.total')}>
                    <span className="font-medium tabular-nums">{format.money(order.total)}</span>
                  </DescriptionItem>
                </DescriptionList>
              </SectionContent>
            </Section>

            <Section title={t('orders.detail.buyerTitle')}>
              <SectionContent>
                {order.buyer === null ? (
                  <div className="grid gap-2 text-sm">
                    {order.buyerDataState === 'unreadable' ? (
                      <Alert tone="critical" role="alert">
                        <OctagonAlert aria-hidden="true" />
                        <p>{t('orders.detail.buyerUnreadable')}</p>
                      </Alert>
                    ) : order.buyerDataErasedAt ? (
                      <p>{t('orders.detail.buyerErased', { date: format.dateTime(order.buyerDataErasedAt) })}</p>
                    ) : null}
                    {order.shippingCountryCode ? (
                      <p className="text-muted-foreground">{t('orders.detail.shippingCountry', { country: order.shippingCountryCode })}</p>
                    ) : null}
                  </div>
                ) : (
                  <DescriptionList>
                    <DescriptionItem term={t('orders.detail.contact')}>
                      {order.buyer.name}
                      {order.buyer.email ? (
                        <>
                          <br />
                          {order.buyer.email}
                        </>
                      ) : null}
                      {order.buyer.phone ? (
                        <>
                          <br />
                          {t('orders.detail.phone', { phone: order.buyer.phone })}
                        </>
                      ) : null}
                      {order.buyer.login ? (
                        <>
                          <br />
                          {t('orders.detail.channelLogin', { login: order.buyer.login })}
                        </>
                      ) : null}
                    </DescriptionItem>
                    <DescriptionItem term={t('orders.detail.shippingAddress')}>
                      <AddressBlock address={order.shippingAddress} />
                    </DescriptionItem>
                    {/* What the Buyer chose on the Channel; a dash where the Channel did not say. */}
                    <DescriptionItem term={t('orders.detail.deliveryMethod')}>{order.delivery?.method ?? <NoValue />}</DescriptionItem>
                    <DescriptionItem term={t('orders.detail.pickupPoint')}>
                      {order.delivery?.pickupPoint ? (
                        <>
                          <Identifier wrap>{order.delivery.pickupPoint.id}</Identifier>
                          {order.delivery.pickupPoint.name ? (
                            <>
                              <br />
                              {order.delivery.pickupPoint.name}
                            </>
                          ) : null}
                        </>
                      ) : (
                        <NoValue />
                      )}
                    </DescriptionItem>
                    <DescriptionItem term={t('orders.detail.billingAddress')}>
                      <AddressBlock address={order.billingAddress} />
                    </DescriptionItem>
                  </DescriptionList>
                )}
              </SectionContent>
            </Section>
          </>
        }
        after={
          <>
            <Section id="channel-changes" title={t('orders.detail.factsTitle')}>
              {order.facts.length === 0 ? (
                <EmptyState>{t('orders.detail.factsEmpty')}</EmptyState>
              ) : (
                <Timeline>
                  {order.facts.map((fact) => (
                    <TimelineItem key={fact.externalId} title={factLabel(t, fact.type)} at={fact.occurredAt} atLabel={format.dateTime(fact.occurredAt)}>
                      {fact.note}
                    </TimelineItem>
                  ))}
                </Timeline>
              )}
            </Section>

            <Section title={t('orders.detail.historyTitle')}>
              {order.events.length === 0 ? (
                <EmptyState>{t('orders.detail.historyEmpty')}</EmptyState>
              ) : (
                <EventTimeline events={order.events} format={format} current={{ type: 'order', id: order.id }} identifiers={eventIdentifiers} />
              )}
            </Section>
          </>
        }
      >
        {needsAttention ? (
          <Notice
            tone="attention"
            title={t('orders.needsAttention')}
            actions={
              manualReasons.length > 0 ? (
                <ActionForm action={resolveAttentionAction} className="grid gap-2">
                  <input type="hidden" name="orderId" value={order.id} />
                  <ActionButton variant="secondary" pendingLabel={t('common.saving')} className="justify-self-start">
                    {t('orders.detail.markReviewed')}
                  </ActionButton>
                </ActionForm>
              ) : undefined
            }
          >
            <ul className="grid gap-2.5">
              {order.attentionReasons.map((reason) => (
                <li key={reason}>
                  <p className="font-medium">{attentionReasonLabel(t, reason)}</p>
                  <p>{recovery[reason].hint}</p>
                  {recovery[reason].links.length > 0 ? (
                    <p className="mt-0.5">
                      {recovery[reason].links.map((link, index) => (
                        <Fragment key={link.href}>
                          {index > 0 ? <span aria-hidden="true">{'\u00a0· '}</span> : null}
                          {/* On a tinted surface a link takes the text's colour and an underline, not the link blue. */}
                          <TextLink href={link.href} className="text-foreground underline">
                            {link.label}
                          </TextLink>
                        </Fragment>
                      ))}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </Notice>
        ) : null}

        <Section id="lines" title={t('orders.detail.linesTitle')}>
          <DataTable align="top">
            <DataTableHeader>
              <DataTableHead hide="narrow">{t('orders.detail.lineColumns.sku')}</DataTableHead>
              <DataTableHead>{t('orders.detail.lineColumns.name')}</DataTableHead>
              <DataTableHead numeric>{t('orders.detail.lineColumns.quantity')}</DataTableHead>
              <DataTableHead numeric hide="narrow">
                {t('orders.detail.lineColumns.price')}
              </DataTableHead>
              <DataTableHead>{t('orders.detail.lineColumns.product')}</DataTableHead>
            </DataTableHeader>
            <DataTableBody>
              {order.lines.map((line) => (
                <DataTableRow key={line.id}>
                  <DataTableCell hide="narrow">{lineSku(line.sku)}</DataTableCell>
                  <DataTableCell narrow="primary" className="@2xl/table:min-w-40">
                    {line.name}
                    <DataTableMeta>
                      <DataTableMetaItem label={t('orders.detail.lineColumns.sku')} labelHidden={line.sku !== null}>
                        {lineSku(line.sku)}
                      </DataTableMetaItem>
                      <DataTableMetaItem label={t('orders.detail.lineColumns.price')}>{format.money(line.unitPrice)}</DataTableMetaItem>
                    </DataTableMeta>
                  </DataTableCell>
                  <DataTableCell numeric narrow="end" narrowLabel={t('orders.detail.lineColumns.quantity')}>
                    {format.number(line.quantity)}
                  </DataTableCell>
                  <DataTableCell numeric hide="narrow">
                    {format.money(line.unitPrice)}
                  </DataTableCell>
                  <DataTableCell narrowLabel={t('orders.detail.lineColumns.product')}>
                    {line.productId ? (
                      <TextLink href={`/products/${line.productId}`} mono>
                        {line.productSku}
                      </TextLink>
                    ) : (
                      <div className="grid gap-2">
                        <AttentionBadge label={t('orders.detail.unmatched')} />
                        <LinkLineForm lineId={line.id} suggestedSku={line.sku} />
                      </div>
                    )}
                  </DataTableCell>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        </Section>

        {/* Where each line's goods are held; a table of its own, so neither it nor the lines need to scroll sideways. */}
        <Section id="reservations" title={t('orders.detail.reservationsTitle')}>
          <DataTable align="top">
            <DataTableHeader>
              <DataTableHead hide="narrow">{t('orders.detail.lineColumns.sku')}</DataTableHead>
              <DataTableHead>{t('orders.detail.lineColumns.name')}</DataTableHead>
              <DataTableHead>{t('orders.detail.lineColumns.reservation')}</DataTableHead>
              <DataTableHead>{t('orders.detail.lineColumns.warehouse')}</DataTableHead>
            </DataTableHeader>
            <DataTableBody>
              {order.lines.map((line) => (
                <DataTableRow key={line.id}>
                  <DataTableCell hide="narrow">{lineSku(line.sku)}</DataTableCell>
                  <DataTableCell narrow="primary" className="@2xl/table:min-w-40">
                    {line.name}
                    <DataTableMeta>
                      <DataTableMetaItem label={t('orders.detail.lineColumns.sku')} labelHidden={line.sku !== null}>
                        {lineSku(line.sku)}
                      </DataTableMetaItem>
                    </DataTableMeta>
                  </DataTableCell>
                  <DataTableCell narrowLabel={t('orders.detail.lineColumns.reservation')}>
                    <span className="flex flex-wrap items-baseline gap-1.5">
                      {line.reservationStatus ? reservationLabel(t, line.reservationStatus) : <NoValue />}
                      {line.shortage ? <AttentionBadge label={t('orders.detail.shortage')} /> : null}
                    </span>
                  </DataTableCell>
                  <DataTableCell narrowLabel={t('orders.detail.lineColumns.warehouse')}>
                    {line.reservationWarehouse ? (
                      // On one baseline with the text inside the control beside it, and through it with the rest of the row.
                      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
                        <span>{line.reservationWarehouse.name}</span>
                        {orderOpen && line.reservationStatus === 'open' && activeWarehouses.length > 1 ? (
                          <MoveReservationForm
                            lineId={line.id}
                            targets={activeWarehouses.filter((warehouse) => warehouse.id !== line.reservationWarehouse?.id)}
                          />
                        ) : null}
                      </div>
                    ) : (
                      <NoValue />
                    )}
                  </DataTableCell>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        </Section>
      </PageColumns>
    </Page>
  )
}
