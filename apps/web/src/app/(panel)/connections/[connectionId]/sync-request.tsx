'use client'

import { createContext, use, useActionState, type ReactNode } from 'react'
import type { ButtonVariant } from '@/components/button-class'
import { ActionButton, FormError, FormSuccess } from '@/components/form'
import type { ActionState } from '@/lib/action-state'
import { requestSyncAction } from '../actions'

const SyncRequestContext = createContext<{ state: ActionState; request: (formData: FormData) => void } | null>(null)

function useSyncRequest() {
  const value = use(SyncRequestContext)
  if (!value) throw new Error('Render this inside <SyncRequest>')
  return value
}

/**
 * One request for a synchronisation, shared by two places on the Connection's page: the button in the page
 * header and the answer in the Synchronisation section, where the results of the run will show.
 */
export function SyncRequest({ children }: { children: ReactNode }) {
  const [state, request] = useActionState(requestSyncAction, {})
  return <SyncRequestContext value={{ state, request }}>{children}</SyncRequestContext>
}

// The labels come from the page: `connections.detail` is not among the messages sent to the browser.
export function SyncNowButton({
  connectionId,
  variant,
  label,
  pendingLabel,
}: {
  connectionId: string
  variant: ButtonVariant
  label: string
  pendingLabel: string
}) {
  const { request } = useSyncRequest()
  return (
    <form action={request}>
      <input type="hidden" name="connectionId" value={connectionId} />
      <ActionButton variant={variant} pendingLabel={pendingLabel}>
        {label}
      </ActionButton>
    </form>
  )
}

export function SyncRequestResult({ success }: { success: string }) {
  const { state } = useSyncRequest()
  if (!state.error && !state.ok) return null
  return (
    <div className="border-b border-border p-4">
      <FormError message={state.error ?? null} />
      <FormSuccess message={state.ok ? success : null} />
    </div>
  )
}
