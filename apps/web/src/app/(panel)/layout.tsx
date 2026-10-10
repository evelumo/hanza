import { listOffers, listOrders } from '@hanza/core'
import { cookies } from 'next/headers'
import type { ReactNode } from 'react'
import { AppSidebar } from '@/components/shell/app-sidebar'
import { TopBar } from '@/components/shell/top-bar'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { SIDEBAR_COOKIE_NAME } from '@/components/ui/sidebar-cookie'
import { getT } from '@/i18n/server'
import { getContext } from '@/lib/context'
import { requireTenant } from '@/lib/session'

const MAIN_ID = 'main-content'

export default async function PanelLayout({ children }: { children: ReactNode }) {
  const { user, organizationId } = await requireTenant()
  const ctx = getContext()
  // The same counts the dashboard's "Needs attention" shows, from the same services, so the sidebar and the
  // lists it leads to cannot disagree. A page of no rows makes each call a count. Offers wait when they have no
  // Product, or a Product whose Stock is unset (#137); the Offers page lists both.
  const noRows = { skip: 0, take: 0 }
  const [organization, attentionOrders, unlinkedOffers, stockUnsetOffers, cookieStore, t] = await Promise.all([
    ctx.db.organization.findUnique({ where: { id: organizationId } }),
    listOrders(ctx, organizationId, { needsAttention: true, ...noRows }),
    listOffers(ctx, organizationId, { linked: false, ...noRows }),
    listOffers(ctx, organizationId, { stockUnset: true, ...noRows }),
    cookies(),
    getT(),
  ])

  return (
    // Rendered collapsed when the person left it so, so the page does not shift after hydration.
    <SidebarProvider defaultOpen={cookieStore.get(SIDEBAR_COOKIE_NAME)?.value !== 'false'}>
      <a
        href={`#${MAIN_ID}`}
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground"
      >
        {t('shell.skipToContent')}
      </a>
      <AppSidebar
        organizationName={organization?.name ?? ''}
        user={{ name: user.name, email: user.email }}
        counts={{ orders: attentionOrders.total, offers: unlinkedOffers.total + stockUnsetOffers.total }}
      />
      <SidebarInset>
        <TopBar />
        {/* Focusable only by the skip link, which is why it shows no ring of its own. */}
        <main id={MAIN_ID} tabIndex={-1} className="mx-auto w-full max-w-[75rem] flex-1 px-4 py-5 outline-none sm:px-6 lg:px-8">
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
