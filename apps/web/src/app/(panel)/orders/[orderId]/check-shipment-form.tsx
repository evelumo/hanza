'use client'

import { ActionForm } from '@/components/action-form'
import { AutoRefresh } from '@/components/auto-refresh'
import { ActionButton } from '@/components/form'
import { checkShipmentAction } from './actions'

// The worker asks the Carrier right away and its answer is on the row a moment later.
const REFRESH_EVERY_MS = 2_000
const REFRESH_FOR_MS = 12_000

/**
 * "Check status" on a Shipment's row. The page cannot tell from the row that a check was asked for (asking changes
 * nothing on it), so this is where the page is re-read for a few seconds after the request went through.
 * The texts come from the page: the section's messages are not sent to the browser.
 */
export function CheckShipmentForm({ shipmentId, label, pendingLabel, requested }: { shipmentId: string; label: string; pendingLabel: string; requested: string }) {
  return (
    <ActionForm action={checkShipmentAction} className="contents" success={requested}>
      {(state) => (
        <>
          <input type="hidden" name="shipmentId" value={shipmentId} />
          <ActionButton variant="secondary" size="sm" pendingLabel={pendingLabel}>
            {label}
          </ActionButton>
          {state.ok ? <AutoRefresh everyMs={REFRESH_EVERY_MS} forMs={REFRESH_FOR_MS} since={state} /> : null}
        </>
      )}
    </ActionForm>
  )
}
