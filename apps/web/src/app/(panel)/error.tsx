'use client'

import { buttonClass } from '@/components/button-class'
import { useT } from '@/i18n/use-t'

// The error itself is never shown: it may contain internals. Next.js logs it on the server.
export default function PanelError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const t = useT()
  return (
    <div role="alert" className="space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">{t('errors.page.title')}</h1>
      <p className="text-muted">{t('errors.page.description')}</p>
      <button type="button" onClick={() => retry()} className={buttonClass('primary')}>
        {t('errors.page.retry')}
      </button>
    </div>
  )
}
