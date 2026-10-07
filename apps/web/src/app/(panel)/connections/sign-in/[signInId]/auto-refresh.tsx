'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

/**
 * Re-renders the page from the server every `everyMs` while a sign-in is open, so the status shows without
 * websockets; the worker does the polling of the Channel, the browser only re-reads Hanza.
 */
export function AutoRefresh({ everyMs }: { everyMs: number }) {
  const router = useRouter()
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), everyMs)
    return () => clearInterval(timer)
  }, [router, everyMs])
  return null
}
