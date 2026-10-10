'use client'

import { OctagonAlert } from 'lucide-react'
import Link from 'next/link'
import { buttonClass } from '@/components/button-class'
import { PageState } from '@/components/page-state'
import { Panel } from '@/components/section'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n/use-t'

// The error itself is never shown: it may contain internals. Next.js logs it on the server.
export default function PanelError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const t = useT()
  return (
    <Panel>
      <div role="alert">
        <PageState icon={OctagonAlert} critical title={t('errors.page.title')} description={t('errors.page.description')}>
          <Link href="/dashboard" className={buttonClass('secondary')}>
            {t('errors.notFound.back')}
          </Link>
          <Button type="button" onClick={() => retry()}>
            {t('errors.page.retry')}
          </Button>
        </PageState>
      </div>
    </Panel>
  )
}
