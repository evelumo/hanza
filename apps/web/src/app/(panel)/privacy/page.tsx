import { canManageOrganization, getPrivacySettings } from '@hanza/core'
import type { Metadata } from 'next'
import { Notice } from '@/components/notice'
import { PageHeader } from '@/components/page-header'
import { Page } from '@/components/page-layout'
import { Section, SectionContent } from '@/components/section'
import { getT } from '@/i18n/server'
import { getContext } from '@/lib/context'
import { requireTenant } from '@/lib/session'
import { ErasureForm } from './erasure-form'
import { RetentionForm } from './retention-form'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('privacy.title') }
}

export default async function PrivacyPage() {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const ctx = getContext()
  const [{ buyerDataRetentionDays: days }, canManage] = await Promise.all([
    getPrivacySettings(ctx, organizationId),
    // The services check this again; here it only decides whether the forms are shown.
    canManageOrganization(ctx, organizationId, user.id),
  ])

  return (
    <Page className="max-w-180">
      <PageHeader title={t('privacy.title')} description={t('privacy.intro')} />

      {canManage ? null : <Notice tone="info">{t('privacy.adminsOnly')}</Notice>}

      <Section title={t('privacy.retention.title')} description={t('privacy.retention.description')}>
        <SectionContent className="space-y-4">
          <p className="text-sm font-medium">
            {days === null ? t('privacy.retention.currentOff') : t('privacy.retention.currentDays', { count: days })}
          </p>
          {canManage ? <RetentionForm days={days} /> : null}
        </SectionContent>
      </Section>

      {canManage ? (
        <Section title={t('privacy.erasure.title')} description={t('privacy.erasure.description')}>
          <SectionContent>
            <ErasureForm />
          </SectionContent>
        </Section>
      ) : null}
    </Page>
  )
}
