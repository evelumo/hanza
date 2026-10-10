'use client'

import { LoaderCircle, OctagonAlert } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n/use-t'
import { enqueuePing } from './actions'

export function PingButton() {
  const router = useRouter()
  const t = useT()
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)

  async function onClick() {
    setPending(true)
    setFailed(false)
    try {
      await enqueuePing()
    } catch {
      // The queue did not take the job (Redis is down, the session ended): say so instead of waiting for a result.
      setFailed(true)
      setPending(false)
      return
    }
    // The worker handles the job asynchronously; give it a moment before reloading the list.
    setTimeout(() => {
      router.refresh()
      setPending(false)
    }, 1_000)
  }

  return (
    <>
      {failed ? (
        <span role="alert" className="inline-flex items-center gap-1 text-meta text-critical">
          <OctagonAlert className="size-3.5 shrink-0" aria-hidden="true" />
          {t('settings.system.pingFailed')}
        </span>
      ) : null}
      <Button type="button" variant="outline" size="sm" onClick={onClick} disabled={pending}>
        {pending ? (
          <>
            <LoaderCircle className="animate-spin" aria-hidden="true" />
            {t('settings.system.sendingPing')}
          </>
        ) : (
          t('settings.system.sendPing')
        )}
      </Button>
    </>
  )
}
