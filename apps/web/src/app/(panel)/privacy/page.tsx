import { canManagePrivacy, getPrivacySettings } from '@hanza/core'
import type { Metadata } from 'next'
import { Section } from '@/components/section'
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
    canManagePrivacy(ctx, organizationId, user.id),
  ])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('privacy.title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">{t('privacy.intro')}</p>
        {canManage ? null : <p className="mt-2 max-w-3xl text-sm font-medium">{t('privacy.adminsOnly')}</p>}
      </div>

      <Section title={t('privacy.retention.title')} description={t('privacy.retention.description')}>
        <div className="space-y-3 px-5 py-4">
          <p className="text-sm font-medium">
            {days === null ? t('privacy.retention.currentOff') : t('privacy.retention.currentDays', { count: days })}
          </p>
          {canManage ? <RetentionForm days={days} /> : null}
        </div>
      </Section>

      {canManage ? (
        <Section title={t('privacy.erasure.title')} description={t('privacy.erasure.description')}>
          <div className="px-5 py-4">
            <ErasureForm />
          </div>
        </Section>
      ) : null}
    </div>
  )
}
