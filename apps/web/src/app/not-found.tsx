import { SearchX } from 'lucide-react'
import Link from 'next/link'
import { AuthShell } from '@/components/auth-shell'
import { buttonClass } from '@/components/button-class'
import { PageState } from '@/components/page-state'
import { getT } from '@/i18n/server'

// Unmatched URLs are rendered here, outside the panel layout, so this one brings its own centred frame.
export default async function NotFound() {
  const t = await getT()
  return (
    <AuthShell>
      <PageState icon={SearchX} title={t('errors.notFound.title')} description={t('errors.notFound.descriptionRoot')}>
        <Link href="/dashboard" className={buttonClass('primary')}>
          {t('errors.notFound.back')}
        </Link>
      </PageState>
    </AuthShell>
  )
}
