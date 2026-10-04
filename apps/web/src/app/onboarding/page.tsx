import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'
import { CreateOrganizationForm } from './create-organization-form'

export default async function OnboardingPage() {
  const session = await getSession()
  if (!session) redirect('/login')
  if (session.session.activeOrganizationId) redirect('/dashboard')

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center px-6 py-12">
      <p className="mb-8 text-2xl font-semibold tracking-tight text-accent">Hanza</p>
      <CreateOrganizationForm />
    </main>
  )
}
