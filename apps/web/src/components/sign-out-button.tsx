'use client'

import { LogOut } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n/use-t'
import { authClient } from '@/lib/auth-client'

/** Ends the session and lands on the sign-in page; shared by this button and the user menu. */
export function useSignOut() {
  const router = useRouter()
  return async function signOut() {
    await authClient.signOut()
    router.push('/login')
    router.refresh()
  }
}

export function SignOutButton() {
  const signOut = useSignOut()
  const t = useT()
  return (
    <Button type="button" variant="ghost" size="sm" onClick={signOut}>
      <LogOut aria-hidden="true" />
      {t('auth.signOut')}
    </Button>
  )
}
