'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { personIsEditing, type EditableField } from '@/lib/form-edits'

const FIELDS = 'input, textarea, select'

/** A field's own element, or null: what has the focus when it is one a person types or chooses in. */
function focusedField(): EditableField | null {
  const active = document.activeElement
  return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement ? active : null
}

/**
 * Re-renders the page from the server every `everyMs`, so what the worker is about to change (a sign-in that is
 * open, a Shipment its Carrier is confirming) shows without websockets: the worker asks the Channel or the Carrier,
 * the browser only re-reads Hanza. Render it only while a change is seconds away, and give it `forMs` where the
 * page cannot tell by itself when to stop. `since` starts the time again when it changes (the answer of an action).
 *
 * It never re-reads the page under a person's hands: a turn is skipped while a field on the page holds something
 * they typed or chose, while they are in one, and while a dialog is open.
 */
export function AutoRefresh({ everyMs, forMs, since }: { everyMs: number; forMs?: number; since?: unknown }) {
  const router = useRouter()
  useEffect(() => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (forMs !== undefined && Date.now() - started >= forMs) {
        clearInterval(timer)
        return
      }
      const fields = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(FIELDS)
      if (document.querySelector('[role="dialog"], [role="alertdialog"]') || personIsEditing(fields, focusedField())) return
      router.refresh()
    }, everyMs)
    return () => clearInterval(timer)
  }, [router, everyMs, forMs, since])
  return null
}
