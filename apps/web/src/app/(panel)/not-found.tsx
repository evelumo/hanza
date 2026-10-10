import { SearchX } from 'lucide-react'
import Link from 'next/link'
import { buttonClass } from '@/components/button-class'
import { PageState } from '@/components/page-state'
import { Panel } from '@/components/section'
import { getT } from '@/i18n/server'

export default async function PanelNotFound() {
  const t = await getT()
  return (
    <Panel>
      <PageState icon={SearchX} title={t('errors.notFound.title')} description={t('errors.notFound.descriptionPanel')}>
        <Link href="/dashboard" className={buttonClass('primary')}>
          {t('errors.notFound.back')}
        </Link>
      </PageState>
    </Panel>
  )
}
