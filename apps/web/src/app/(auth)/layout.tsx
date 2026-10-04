import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { getSession } from '@/lib/session'

export default async function AuthLayout({ children }: { children: ReactNode }) {
  if (await getSession()) redirect('/dashboard')

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center px-6 py-12">
      <p className="mb-8 text-2xl font-semibold tracking-tight text-accent">Hanza</p>
      {children}
    </main>
  )
}
