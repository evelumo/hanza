import type { ConnectionRow } from '@hanza/core'
import { Cable } from 'lucide-react'
import Link from 'next/link'
import { buttonClass } from '@/components/button-class'
import { EmptyState } from '@/components/empty-state'
import { LinkList, LinkRow } from '@/components/link-list'
import { Section } from '@/components/section'
import { HealthBadge } from '@/components/status-badge'
import { TextLink } from '@/components/text-link'
import { useT } from '@/i18n/use-t'
import type { Formatters } from '@/lib/format'
import { connectionsToShow, lastSynchronisedAt } from './overview'

export function ConnectionsSection({ connections, format }: { connections: ConnectionRow[]; format: Formatters }) {
  const t = useT()
  const { shown, more } = connectionsToShow(connections)
  return (
    <Section
      title={t('dashboard.connections.title')}
      actions={
        connections.length > 0 ? (
          <TextLink href="/connections" className="text-meta">
            {t('dashboard.connections.all')}
          </TextLink>
        ) : undefined
      }
    >
      {connections.length === 0 ? (
        <EmptyState
          icon={Cable}
          title={t('dashboard.connections.emptyTitle')}
          className="py-8"
          action={
            <Link href="/connections/new" className={buttonClass('secondary')}>
              {t('connections.add')}
            </Link>
          }
        >
          {t('dashboard.connections.empty')}
        </EmptyState>
      ) : (
        <LinkList>
          {shown.map((connection) => {
            const syncedAt = lastSynchronisedAt(connection.syncStates)
            return (
              <LinkRow
                key={connection.id}
                href={`/connections/${connection.id}`}
                className="py-2.5"
                inline
                title={connection.name}
                detail={
                  syncedAt ? (
                    <time dateTime={syncedAt.toISOString()} className="tabular-nums">
                      {t('dashboard.connections.lastSync', { date: format.dateTime(syncedAt) })}
                    </time>
                  ) : (
                    t('dashboard.connections.neverSynced')
                  )
                }
                trailing={<HealthBadge health={connection.health} />}
              />
            )
          })}
          {more > 0 ? (
            <LinkRow
              href="/connections"
              className="py-2.5"
              title={<span className="font-normal text-muted-foreground">{t('dashboard.connections.more', { count: more })}</span>}
            />
          ) : null}
        </LinkList>
      )}
    </Section>
  )
}
