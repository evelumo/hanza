'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

/**
 * Re-renders the page from the server every `everyMs`, so what the worker is about to change (a sign-in that is
 * open, a Shipment the Carrier is confirming) shows without websockets: the worker asks the Channel or the Carrier,
 * the browser only re-reads Hanza. Render it only while something is expected; what a person typed into a form stays.
 */
export function AutoRefresh({ everyMs }: { everyMs: number }) {
  const router = useRouter()
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), everyMs)
    return () => clearInterval(timer)
  }, [router, everyMs])
  return null
}
