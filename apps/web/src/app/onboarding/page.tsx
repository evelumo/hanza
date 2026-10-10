import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { AuthShell } from '@/components/auth-shell'
import { SignOutButton } from '@/components/sign-out-button'
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
    // The way out for someone who signed up with the wrong account: there is no panel to sign out from yet.
    <AuthShell footer={<SignOutButton />}>
      <CreateOrganizationForm />
    </AuthShell>
  )
}
