'use client'

import type { Money, ShippingService } from '@hanza/connector-sdk'
import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { ActionForm } from '@/components/action-form'
import { ActionButton, Field, Select } from '@/components/form'
import { useT } from '@/i18n/use-t'
import { defaultServiceId } from '@/lib/shipments'
import { createShipmentAction } from './actions'

export interface ShipmentFormConnection {
  id: string
  name: string
  /** The Connection is failing or waits for a sign-in: a Shipment made now waits with it. */
  trouble: boolean
  /** At least one. */
  services: ShippingService[]
}

/**
 * A select whose choice is kept in state, because other fields follow it. To React such a select has no default:
 * when React resets the form after its action, the browser puts it back on its first option while the state still
 * holds the choice, and the two would then disagree about which fields are sent. So the chosen option is also
 * marked as the default one. A reset then lands on the choice, and the select never looks like something a person
 * left half filled in (see `AutoRefresh`).
 */
function ChoiceSelect({ value, ...select }: ComponentProps<typeof Select> & { value: string }) {
  const node = useRef<HTMLSelectElement>(null)
  // After every render: the options are replaced when the list they come from changes.
  useEffect(() => {
    for (const option of node.current?.options ?? []) option.defaultSelected = option.value === value
  })
  return <Select ref={node} value={value} {...select} />
}

/**
 * The form for a new Shipment. The fields below the service follow the chosen service (a parcel size or dimensions,
 * a pickup point or none, cash on delivery or none); the choice is kept here, in the browser, so changing it costs
 * no round trip, and the server reads the same fields from the same declaration when the form is sent.
 */
export function CreateShipmentForm({
  orderId,
  connections,
  pickupPointId,
  cashOnDelivery,
}: {
  orderId: string
  connections: ShipmentFormConnection[]
  /** The pickup point of the Order's Delivery, when the Channel gave one. */
  pickupPointId: string | null
  /** The Order's total when the Carrier may collect it (a cash-on-delivery Order), else null. */
  cashOnDelivery: Money | null
}) {
  const t = useT()
  const serviceFor = (connection: ShipmentFormConnection) => defaultServiceId(connection.services, pickupPointId !== null) ?? ''
  const [connectionId, setConnectionId] = useState(connections[0]!.id)
  const connection = connections.find((candidate) => candidate.id === connectionId) ?? connections[0]!
  const [serviceId, setServiceId] = useState(() => serviceFor(connection))
  const service = connection.services.find((candidate) => candidate.id === serviceId) ?? connection.services[0]!

  return (
    <ActionForm
      action={createShipmentAction}
      // Below the two-column layout the section is as wide as the page; a form of a few short fields is not.
      className="grid max-w-md gap-3"
      // It orders a label from the Carrier, so it asks first, like every form with a consequence.
      confirm={t('orders.createShipment.confirm')}
      success={t('orders.createShipment.created')}
      actions={
        <ActionButton variant="secondary" pendingLabel={t('orders.createShipment.submitting')}>
          {t('orders.createShipment.submit')}
        </ActionButton>
      }
    >
      {(state) => {
        const error = state.fieldErrors ?? {}
        const sent = state.values ?? {}
        const measure = (name: 'lengthCm' | 'widthCm' | 'heightCm' | 'weightKg', label: string) => (
          <Field name={name} label={label} required inputMode="decimal" autoComplete="off" defaultValue={sent[name] ?? ''} error={error[name]} />
        )
        return (
          <>
            <input type="hidden" name="orderId" value={orderId} />
            <ChoiceSelect
              name="connectionId"
              label={t('orders.createShipment.connection')}
              value={connection.id}
              onChange={(event) => {
                const next = connections.find((candidate) => candidate.id === event.target.value) ?? connection
                setConnectionId(next.id)
                setServiceId(serviceFor(next))
              }}
              error={error.connectionId}
              hint={connection.trouble ? t('orders.createShipment.connectionTrouble') : undefined}
            >
              {connections.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </ChoiceSelect>
            <ChoiceSelect
              name="service"
              label={t('orders.createShipment.service')}
              value={service.id}
              onChange={(event) => setServiceId(event.target.value)}
              error={error.service}
              // Without a pickup point to ask for, the one thing to know is where the parcel goes.
              hint={service.destination === 'address' ? t('orders.createShipment.toAddress') : undefined}
            >
              {connection.services.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </ChoiceSelect>

            {service.parcel.type === 'presets' ? (
              // Keyed by the service: another one's sizes start from its own first, not from a stale choice.
              <Select key={service.id} name="preset" label={t('orders.createShipment.preset')} defaultValue={sent.preset} error={error.preset}>
                {service.parcel.presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ))}
              </Select>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {measure('lengthCm', t('orders.createShipment.length'))}
                {measure('widthCm', t('orders.createShipment.width'))}
                {measure('heightCm', t('orders.createShipment.height'))}
                {measure('weightKg', t('orders.createShipment.weight'))}
              </div>
            )}

            {service.destination === 'pickup_point' ? (
              <Field
                name="pickupPoint"
                label={t('orders.createShipment.pickupPoint')}
                required
                maxLength={100}
                autoComplete="off"
                spellCheck={false}
                defaultValue={sent.pickupPoint ?? pickupPointId ?? ''}
                error={error.pickupPoint}
                hint={t('orders.createShipment.pickupPointHint')}
                className="font-mono"
              />
            ) : null}

            {service.cashOnDelivery && cashOnDelivery ? (
              <Field
                name="cashOnDelivery"
                label={t('orders.createShipment.cashOnDelivery', { currency: cashOnDelivery.currency })}
                inputMode="decimal"
                autoComplete="off"
                defaultValue={sent.cashOnDelivery ?? cashOnDelivery.amount}
                error={error.cashOnDelivery}
                hint={t('orders.createShipment.cashOnDeliveryHint')}
              />
            ) : null}
          </>
        )
      }}
    </ActionForm>
  )
}
