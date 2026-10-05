import type { ReactNode } from 'react'
import { NavLinks } from '@/components/nav-links'
import { SignOutButton } from '@/components/sign-out-button'
import { getContext } from '@/lib/context'
import { requireTenant } from '@/lib/session'

export default async function PanelLayout({ children }: { children: ReactNode }) {
  const { user, organizationId } = await requireTenant()
  const organization = await getContext().db.organization.findUnique({ where: { id: organizationId } })

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-6 py-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <div className="flex items-baseline gap-3">
              <span className="text-lg font-semibold tracking-tight text-accent">Hanza</span>
              <span className="text-sm text-muted">{organization?.name}</span>
            </div>
            <NavLinks />
          </div>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-muted">{user.email}</span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  )
}
