import { SHIPMENT_CREATE_RETRY_DELAY_MS, type OrderDetail, type ShipmentRow, type ShippingConnection } from '@hanza/core'
import { OctagonAlert, TriangleAlert, Truck } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { ActionForm } from '@/components/action-form'
import { AutoRefresh } from '@/components/auto-refresh'
import { buttonClass } from '@/components/button-class'
import { DataTable, DataTableBody, DataTableCell, DataTableHead, DataTableHeader, DataTableMeta, DataTableMetaItem, DataTableRow } from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import { ActionButton } from '@/components/form'
import { Identifier } from '@/components/identifier'
import { NoValue } from '@/components/no-value'
import { Section, SectionContent } from '@/components/section'
import { ShipmentStatusBadge } from '@/components/status-badge'
import { TextLink } from '@/components/text-link'
import { toneTextClass } from '@/components/tone'
import { useT } from '@/i18n/use-t'
import { pickupSettling, shipmentBlocker, shipmentNotes, shipmentSettling, type ShipmentConnection, type ShipmentNote } from '@/lib/shipments'
import { cn } from '@/lib/utils'
import { cancelShipmentAction } from './actions'
import { CheckShipmentForm } from './check-shipment-form'
import { CreateShipmentForm } from './create-shipment-form'

// How often the page re-reads itself while a Shipment is about to change; the worker's answer takes a few seconds.
const REFRESH_EVERY_MS = 3_000

/** A sentence under a Shipment: quiet when it only informs, toned (with an icon, never by colour alone) when a person has to act. */
function Note({ tone, children }: { tone?: 'warning' | 'critical'; children: ReactNode }) {
  const Icon = tone === 'critical' ? OctagonAlert : TriangleAlert
  return (
    <p className={cn('flex max-w-sm items-start gap-1 text-meta', tone ? cn('font-medium', toneTextClass[tone]) : 'text-muted-foreground')}>
      {tone ? <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /> : null}
      <span>{children}</span>
    </p>
  )
}

// What a person has to do something about, and how urgently; the rest only informs.
const NOTE_TONE: Partial<Record<ShipmentNote['kind'], 'warning' | 'critical'>> = {
  failed: 'critical',
  mayExistAtCarrier: 'warning',
  retrying: 'warning',
  cancelQueued: 'warning',
  connectionWaiting: 'warning',
  cancelRefused: 'warning',
  cancelUnsupported: 'warning',
  labelFailed: 'warning',
}

/**
 * The Order's Shipments, and the form for a new one: what a person packing the Order needs after its status. With no
 * Connection that makes Shipments there is nothing to create one through; an Order that cannot get one says why.
 */
export function ShipmentsSection({
  order,
  shipments,
  connections,
}: {
  order: Pick<OrderDetail, 'id' | 'phase' | 'awaitingPayment' | 'buyerDataState' | 'payment' | 'total' | 'delivery'>
  shipments: ShipmentRow[]
  connections: ShippingConnection[]
}) {
  const t = useT()
  const blocker = shipmentBlocker(order)
  const offered = connections.filter((connection) => connection.services.length > 0)
  const now = new Date()
  const through = new Map(
    connections.map(({ id, health, canCancel }): [string, ShipmentConnection] => [id, { canCancel, trouble: health === 'failing' || health === 'auth_expired' }]),
  )

  // A Carrier's own code cannot be translated, and is never read as anything but text: it stands beside the
  // sentence, in the identifier face.
  const withCode = (sentence: string, code: string) => (
    <>
      {sentence}{' '}
      {/* A whole code moves to the next line when it fits there; only one longer than the line breaks inside. */}
      <Identifier wrap className="break-normal wrap-anywhere">
        {code}
      </Identifier>
    </>
  )
  const noteText = (note: ShipmentNote, shipment: ShipmentRow): ReactNode => {
    switch (note.kind) {
      case 'failed':
        if (note.reason) return t(note.reason)
        return note.code ? withCode(`${t('orders.shipments.note.failedByCarrier')} ${t('orders.shipments.note.code')}`, note.code) : t('orders.shipments.note.failed')
      case 'retrying':
      case 'cancelQueued':
        return t(`orders.shipments.note.${note.kind}`, { minutes: Math.round(SHIPMENT_CREATE_RETRY_DELAY_MS / 60_000) })
      case 'connectionWaiting':
        return (
          <>
            {t('orders.shipments.note.connectionWaiting')}{' '}
            <TextLink href={`/connections/${shipment.connectionId}`} className="text-foreground underline">
              {t('orders.detail.attention.toConnection', { connection: shipment.connectionName })}
            </TextLink>
          </>
        )
      case 'unconfirmed':
        return withCode(t('orders.shipments.note.unconfirmed'), note.code)
      case 'cancelRefused':
        return withCode(`${t('orders.shipments.note.cancelRefused')} ${t('orders.shipments.note.code')}`, note.code)
      case 'labelFailed':
        return `${t('orders.shipments.note.labelFailed')} ${t(note.reason)}`
      default:
        return t(`orders.shipments.note.${note.kind}`)
    }
  }

  return (
    <Section id="shipments" title={t('orders.shipments.title')} description={t('orders.shipments.description')}>
      {shipments.some((shipment) => shipmentSettling(shipment, now)) || pickupSettling(order, shipments, now) ? <AutoRefresh everyMs={REFRESH_EVERY_MS} /> : null}
      {shipments.length > 0 ? (
        <DataTable align="top">
          <DataTableHeader>
            <DataTableHead>{t('orders.shipments.columns.carrier')}</DataTableHead>
            <DataTableHead hide="narrow">{t('orders.shipments.columns.service')}</DataTableHead>
            <DataTableHead>{t('orders.shipments.columns.status')}</DataTableHead>
            <DataTableHead>{t('orders.shipments.columns.tracking')}</DataTableHead>
            <DataTableHead>{t('orders.shipments.columns.next')}</DataTableHead>
          </DataTableHeader>
          <DataTableBody>
            {shipments.map((shipment) => {
              const service = shipment.serviceName ?? <Identifier>{shipment.service}</Identifier>
              const notes = shipmentNotes(shipment, through.get(shipment.connectionId) ?? null)
              return (
                <DataTableRow key={shipment.id}>
                  <DataTableCell narrow="primary" className="font-medium">
                    {shipment.connectionName}
                    <DataTableMeta>
                      <DataTableMetaItem label={t('orders.shipments.columns.service')} labelHidden>
                        {service}
                      </DataTableMetaItem>
                    </DataTableMeta>
                  </DataTableCell>
                  <DataTableCell hide="narrow">{service}</DataTableCell>
                  <DataTableCell narrow="end">
                    <ShipmentStatusBadge status={shipment.status} />
                    {shipment.carrierStatus ? (
                      <span className="mt-1 block text-muted-foreground">
                        <span className="sr-only">{t('orders.shipments.carrierStatus')}: </span>
                        <Identifier>{shipment.carrierStatus}</Identifier>
                      </span>
                    ) : null}
                  </DataTableCell>
                  <DataTableCell narrowLabel={t('orders.shipments.columns.trackingShort')}>
                    {shipment.trackingNumber ? <Identifier>{shipment.trackingNumber}</Identifier> : <NoValue />}
                  </DataTableCell>
                  <DataTableCell className="@2xl/table:min-w-56">
                    <div className="grid gap-2">
                      {notes.map((note) => (
                        <Note key={note.kind} tone={NOTE_TONE[note.kind]}>
                          {noteText(note, shipment)}
                        </Note>
                      ))}
                      {shipment.hasLabel || shipment.canCheck || shipment.canCancel ? (
                        // Each button is a form of its own, laid out as if it were not there (`contents`), so the buttons
                        // share one row and whatever an action answers takes a row of its own below all of them.
                        <div className="flex flex-wrap items-center gap-2 [&>form>div]:order-last">
                          {shipment.hasLabel ? (
                            // A file from a route handler, not a page: a plain link, so the router does not try to render it.
                            <a href={`/orders/${order.id}/shipments/${shipment.id}/label`} download className={buttonClass('secondary', 'sm')}>
                              {t('orders.shipments.downloadLabel')}
                            </a>
                          ) : null}
                          {shipment.canCheck ? (
                            <CheckShipmentForm
                              shipmentId={shipment.id}
                              label={t('orders.shipments.check')}
                              pendingLabel={t('orders.shipments.checking')}
                              requested={t('orders.shipments.checkRequested')}
                            />
                          ) : null}
                          {shipment.canCancel ? (
                            <ActionForm action={cancelShipmentAction} className="contents" confirm={t('orders.shipments.confirmCancel')}>
                              <input type="hidden" name="shipmentId" value={shipment.id} />
                              <ActionButton variant="danger" size="sm" pendingLabel={t('orders.shipments.cancelling')}>
                                {t('orders.shipments.cancel')}
                              </ActionButton>
                            </ActionForm>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </DataTableCell>
                </DataTableRow>
              )
            })}
          </DataTableBody>
        </DataTable>
      ) : null}

      {blocker ? (
        <p className={cn('px-4 py-4 text-sm text-muted-foreground', shipments.length > 0 && 'border-t border-border')}>
          {t(`orders.shipments.unavailable.${blocker}`)}
        </p>
      ) : offered.length === 0 ? (
        <EmptyState
          icon={Truck}
          title={t('orders.shipments.noCarrierTitle')}
          action={
            <Link href="/connections" className={buttonClass('secondary')}>
              {t('orders.shipments.noCarrierAction')}
            </Link>
          }
        >
          {t('orders.shipments.noCarrier')}
        </EmptyState>
      ) : (
        <SectionContent className={cn('grid gap-3', shipments.length > 0 && 'border-t border-border')}>
          <h3 className="text-meta font-medium text-muted-foreground">{t('orders.shipments.createHeading')}</h3>
          <CreateShipmentForm
            orderId={order.id}
            connections={offered.map(({ id, name, health, services }) => ({ id, name, services, trouble: health === 'failing' || health === 'auth_expired' }))}
            pickupPointId={order.delivery?.pickupPoint?.id ?? null}
            cashOnDelivery={order.payment === 'cash_on_delivery' ? order.total : null}
          />
        </SectionContent>
      )}
    </Section>
  )
}
