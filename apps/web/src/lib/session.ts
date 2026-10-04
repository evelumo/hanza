import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from './auth'

export async function getSession() {
  return auth.api.getSession({ headers: await headers() })
}

/** Use in every panel page, route and action: all tenant data is scoped by `organizationId`. */
export async function requireTenant() {
  const session = await getSession()
  if (!session) redirect('/login')

  const organizationId = session.session.activeOrganizationId
  if (!organizationId) redirect('/onboarding')

  return { user: session.user, organizationId }
}
