'use client'

import { buttonClass } from '@/components/button-class'

// The error itself is never shown: it may contain internals. Next.js logs it on the server.
export default function PanelError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <div role="alert" className="space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">Coś poszło nie tak</h1>
      <p className="text-muted">Nie udało się wyświetlić tej strony. Spróbuj ponownie za chwilę.</p>
      <button type="button" onClick={() => retry()} className={buttonClass('primary')}>
        Spróbuj ponownie
      </button>
    </div>
  )
}
