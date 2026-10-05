import type { Metadata } from 'next'
import { getT } from '@/i18n/server'
import { getContext } from '@/lib/context'
import { getFormatters } from '@/lib/formatters'
import { requireTenant } from '@/lib/session'
import { PingButton } from './ping-button'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('dashboard.title') }
}

export default async function DashboardPage() {
  const { organizationId } = await requireTenant()
  const [t, format] = await Promise.all([getT(), getFormatters()])
  const events = await getContext().db.eventLog.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
    take: 10,
  })

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('dashboard.title')}</h1>
        <p className="mt-1 text-muted">{t('dashboard.intro')}</p>
      </div>

      <section className="rounded-lg border border-line bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="font-semibold">{t('dashboard.eventsTitle')}</h2>
            <p className="text-sm text-muted">{t('dashboard.eventsDescription')}</p>
          </div>
          <PingButton />
        </div>
        {events.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted">{t('dashboard.eventsEmpty')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {events.map((event) => (
              <li key={event.id} className="flex items-center justify-between gap-4 px-5 py-3 text-sm">
                <code className="font-mono">{event.type}</code>
                <time dateTime={event.createdAt.toISOString()} className="text-muted">
                  {format.dateTime(event.createdAt)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
