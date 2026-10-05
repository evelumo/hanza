'use client'

import { useRouter } from 'next/navigation'
import { useT } from '@/i18n/use-t'
import { authClient } from '@/lib/auth-client'

export function SignOutButton() {
  const router = useRouter()
  const t = useT()

  async function signOut() {
    await authClient.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <button type="button" onClick={signOut} className="font-medium text-accent underline">
      {t('auth.signOut')}
    </button>
  )
}
