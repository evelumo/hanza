'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Fragment } from 'react'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import { useT } from '@/i18n/use-t'
import { breadcrumbsFor } from './navigation'

export function Breadcrumbs() {
  const t = useT()
  const crumbs = breadcrumbsFor(usePathname())
  if (crumbs.length === 0) return null
  return (
    <Breadcrumb aria-label={t('shell.breadcrumb.label')} className="min-w-0">
      <BreadcrumbList>
        {crumbs.map((crumb, index) => {
          // On a narrow screen only the end of the trail fits.
          const narrow = index < crumbs.length - 1 ? 'max-sm:hidden' : undefined
          return (
            <Fragment key={`${index}:${crumb.label}`}>
              {index > 0 ? <BreadcrumbSeparator className="max-sm:hidden" /> : null}
              <BreadcrumbItem className={narrow}>
                {crumb.current ? (
                  <BreadcrumbPage>{t(crumb.label)}</BreadcrumbPage>
                ) : crumb.href ? (
                  <BreadcrumbLink asChild>
                    <Link href={crumb.href}>{t(crumb.label)}</Link>
                  </BreadcrumbLink>
                ) : (
                  <span className="truncate">{t(crumb.label)}</span>
                )}
              </BreadcrumbItem>
            </Fragment>
          )
        })}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
