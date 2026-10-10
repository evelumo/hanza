import type { Metadata } from 'next'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { Page } from '@/components/page-layout'
import { Section } from '@/components/section'
import { Timeline, TimelineItem } from '@/components/timeline'
import { getT } from '@/i18n/server'
import { getContext } from '@/lib/context'
import { describeEvent } from '@/lib/events'
import { getFormatters } from '@/lib/formatters'
import { requireTenant } from '@/lib/session'
import { SettingsNav } from '../settings-nav'
import { PingButton } from './ping-button'

export const dynamic = 'force-dynamic'

const TEST_JOBS_SHOWN = 5

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('settings.system.title') }
}

export default async function SystemPage() {
  const { organizationId } = await requireTenant()
  const [t, format] = await Promise.all([getT(), getFormatters()])
  // Only the test job's own Events: the other Events of the organization are on the dashboard.
  const pings = await getContext().db.eventLog.findMany({
    where: { organizationId, type: 'system.ping' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: TEST_JOBS_SHOWN,
    select: { id: true, type: true, createdAt: true },
  })

  return (
    <Page className="max-w-180">
      <SettingsNav current="/settings/system" />
      <PageHeader title={t('settings.system.title')} description={t('settings.system.description')} />

      <Section title={t('settings.system.queueTitle')} description={t('settings.system.queueDescription')} actions={<PingButton />}>
        {pings.length === 0 ? (
          <EmptyState>{t('settings.system.queueEmpty')}</EmptyState>
        ) : (
          <Timeline>
            {pings.map((ping) => (
              <TimelineItem key={ping.id} title={describeEvent(ping.type, {}, t, format).title} at={ping.createdAt} atLabel={format.dateTime(ping.createdAt)}>
                {t('settings.system.queueDone')}
              </TimelineItem>
            ))}
          </Timeline>
        )}
      </Section>
    </Page>
  )
}
