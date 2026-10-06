'use client'

import { ActionForm } from '@/components/action-form'
import { ActionButton } from '@/components/form'
import { useT } from '@/i18n/use-t'
import { moveReservationAction } from './actions'

/** Moves a line's open Reservation to another active Warehouse; the server re-checks that it covers the line. */
export function MoveReservationForm({ lineId, targets }: { lineId: string; targets: Array<{ id: string; name: string }> }) {
  const t = useT()
  const selectId = `move-${lineId}`
  return (
    <ActionForm action={moveReservationAction} className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="orderLineId" value={lineId} />
        <label className="sr-only" htmlFor={selectId}>
          {t('orders.moveReservation.label')}
        </label>
        <select
          id={selectId}
          name="warehouseId"
          required
          title={t('orders.moveReservation.hint')}
          className="rounded-md border border-line bg-white px-2 py-1.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
        >
          {targets.map((target) => (
            <option key={target.id} value={target.id}>
              {target.name}
            </option>
          ))}
        </select>
        <ActionButton variant="secondary" pendingLabel={t('orders.moveReservation.submitting')}>
          {t('orders.moveReservation.submit')}
        </ActionButton>
      </div>
    </ActionForm>
  )
}
