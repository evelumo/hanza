import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { LanguageSwitcher } from '@/components/language-switcher'
import { getT } from '@/i18n/server'
import { getSession } from '@/lib/session'
import { CreateOrganizationForm } from './create-organization-form'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('auth.onboarding.title') }
}

export default async function OnboardingPage() {
  const session = await getSession()
  if (!session) redirect('/login')
  if (session.session.activeOrganizationId) redirect('/dashboard')

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center px-6 py-12">
      <div className="mb-8 flex items-center justify-between">
        <p className="text-2xl font-semibold tracking-tight text-accent">Hanza</p>
        <LanguageSwitcher />
      </div>
      <CreateOrganizationForm />
    </main>
  )
}
