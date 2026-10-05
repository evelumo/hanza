'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const links = [
  { href: '/dashboard', label: 'Pulpit' },
  { href: '/products', label: 'Produkty' },
  { href: '/orders', label: 'Zamówienia' },
  { href: '/connections', label: 'Połączenia' },
]

export function NavLinks() {
  const pathname = usePathname()
  return (
    <nav aria-label="Główna nawigacja" className="flex flex-wrap gap-1 text-sm">
      {links.map((link) => {
        const active = pathname === link.href || pathname.startsWith(`${link.href}/`)
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? 'page' : undefined}
            className={`rounded-md px-3 py-1.5 font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
              active ? 'bg-accent text-white' : 'text-ink hover:bg-canvas'
            }`}
          >
            {link.label}
          </Link>
        )
      })}
    </nav>
  )
}
