'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useT } from '@/i18n/use-t'
import type { MessageKey } from '@/i18n/types'

// `section` is the path prefix that marks the link as current, when it differs from `href`.
const links: Array<{ href: string; label: MessageKey; section?: string }> = [
  { href: '/dashboard', label: 'nav.dashboard' },
  { href: '/products', label: 'nav.products' },
  { href: '/orders', label: 'nav.orders' },
  { href: '/connections', label: 'nav.connections' },
  { href: '/settings/order-statuses', label: 'nav.settings', section: '/settings' },
]

export function NavLinks() {
  const pathname = usePathname()
  const t = useT()
  return (
    <nav aria-label={t('nav.label')} className="flex flex-wrap gap-1 text-sm">
      {links.map((link) => {
        const section = link.section ?? link.href
        const active = pathname === section || pathname.startsWith(`${section}/`)
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? 'page' : undefined}
            className={`rounded-md px-3 py-1.5 font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
              active ? 'bg-accent text-white' : 'text-ink hover:bg-canvas'
            }`}
          >
            {t(link.label)}
          </Link>
        )
      })}
    </nav>
  )
}
