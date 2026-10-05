import Link from 'next/link'
import { linkClass } from '@/components/section'
import { getT } from '@/i18n/server'

// Unmatched URLs are rendered here, outside the panel layout, so this one needs its own centred wrapper.
export default async function NotFound() {
  const t = await getT()
  return (
    <main className="mx-auto max-w-xl space-y-2 px-6 py-24">
      <h1 className="text-2xl font-semibold tracking-tight">{t('errors.notFound.title')}</h1>
      <p className="text-muted">{t('errors.notFound.descriptionRoot')}</p>
      <Link href="/dashboard" className={linkClass}>
        {t('errors.notFound.back')}
      </Link>
    </main>
  )
}
