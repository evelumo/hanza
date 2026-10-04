'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { enqueuePing } from './actions'

export function PingButton() {
  const router = useRouter()
  const [pending, setPending] = useState(false)

  async function onClick() {
    setPending(true)
    await enqueuePing()
    // The worker handles the job asynchronously; give it a moment before reloading the list.
    setTimeout(() => {
      router.refresh()
      setPending(false)
    }, 1_000)
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-strong disabled:opacity-60"
    >
      {pending ? 'Wysyłanie…' : 'Wyślij zadanie testowe'}
    </button>
  )
}
