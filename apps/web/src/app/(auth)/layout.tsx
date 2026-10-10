import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { AuthShell } from '@/components/auth-shell'
import { getSession } from '@/lib/session'

export default async function AuthLayout({ children }: { children: ReactNode }) {
  if (await getSession()) redirect('/dashboard')

  return <AuthShell>{children}</AuthShell>
}
