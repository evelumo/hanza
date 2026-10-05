import Link from 'next/link'
import { linkClass } from '@/components/section'
import { getT } from '@/i18n/server'

export default async function PanelNotFound() {
  const t = await getT()
  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold tracking-tight">{t('errors.notFound.title')}</h1>
      <p className="text-muted">{t('errors.notFound.descriptionPanel')}</p>
      <Link href="/dashboard" className={linkClass}>
        {t('errors.notFound.back')}
      </Link>
    </div>
  )
}
