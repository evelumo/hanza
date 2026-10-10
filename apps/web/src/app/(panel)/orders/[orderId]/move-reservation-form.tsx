'use client'

import { ActionForm } from '@/components/action-form'
import { ActionButton, Select } from '@/components/form'
import { useT } from '@/i18n/use-t'
import { moveReservationAction } from './actions'

/** Moves a line's open Reservation to another active Warehouse; the server re-checks that it covers the line. */
export function MoveReservationForm({ lineId, targets }: { lineId: string; targets: Array<{ id: string; name: string }> }) {
  const t = useT()
  return (
    <ActionForm action={moveReservationAction} className="grid gap-2">
      <div className="flex flex-wrap items-start gap-2">
        <input type="hidden" name="orderLineId" value={lineId} />
        <Select
          id={`move-${lineId}`}
          name="warehouseId"
          label={t('orders.moveReservation.label')}
          labelHidden
          compact
          required
          title={t('orders.moveReservation.hint')}
          className="w-36"
        >
          {targets.map((target) => (
            <option key={target.id} value={target.id}>
              {target.name}
            </option>
          ))}
        </Select>
        <ActionButton variant="secondary" size="sm" pendingLabel={t('orders.moveReservation.submitting')}>
          {t('orders.moveReservation.submit')}
        </ActionButton>
      </div>
    </ActionForm>
  )
}
