import { deviceFlowOf } from '@hanza/connector-sdk'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Fragment } from 'react'
import { EmptyState } from '@/components/empty-state'
import { Identifier } from '@/components/identifier'
import { LinkList, LinkRow } from '@/components/link-list'
import { Notice } from '@/components/notice'
import { PageHeader } from '@/components/page-header'
import { Page } from '@/components/page-layout'
import { Panel, Section, SectionContent } from '@/components/section'
import { TagBadge } from '@/components/status-badge'
import { getT } from '@/i18n/server'
import { describeFields } from '@/lib/connector-form'
import { getContext } from '@/lib/context'
import { labelOrRaw } from '@/lib/labels'
import { firstParam } from '@/lib/pagination'
import { requireTenant } from '@/lib/session'
import { NewConnectionForm } from './new-connection-form'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('connections.new.title') }
}

/** The settings an installation lacks, as the names to put in its environment: identifiers, so in the identifier face. */
function Variables({ names }: { names: string[] }) {
  return names.map((name, index) => (
    <Fragment key={name}>
      {index > 0 ? ', ' : null}
      {/* A whole name moves to the next line when it fits there; only one longer than the line breaks inside. */}
      <Identifier wrap className="break-normal wrap-anywhere">
        {name}
      </Identifier>
    </Fragment>
  ))
}

export default async function NewConnectionPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireTenant()
  const t = await getT()
  const connectorId = firstParam((await searchParams).connector)
  const ctx = getContext()

  if (!connectorId) {
    const connectors = ctx.connectors.list()
    return (
      <Page>
        <PageHeader
          back={{ href: '/connections', label: t('connections.title') }}
          title={t('connections.new.title')}
          description={t('connections.new.description')}
        />
        <Panel className="max-w-[35rem]">
          {connectors.length === 0 ? (
            <EmptyState>{t('connections.new.noConnectors')}</EmptyState>
          ) : (
            <LinkList>
              {connectors.map((connector) => {
                const settings = ctx.connectors.settings(connector.id)
                const kind = labelOrRaw(t, 'labels.connectorKind', connector.kind)
                // Not set up on this installation: listed for the operator, but it cannot be connected.
                if (!settings.ok) {
                  return (
                    <li key={connector.id} className="px-4 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                        <span className="text-sm font-medium text-muted-foreground">{connector.name}</span>
                        <TagBadge label={t('connections.new.notConfigured')} />
                      </div>
                      <p className="text-meta text-muted-foreground">{kind}</p>
                      <p className="mt-1.5 text-meta text-muted-foreground">
                        {t('connections.new.notConfiguredHint')} <Variables names={settings.variables} />
                      </p>
                    </li>
                  )
                }
                return <LinkRow key={connector.id} href={`/connections/new?connector=${encodeURIComponent(connector.id)}`} title={connector.name} detail={kind} />
              })}
            </LinkList>
          )}
        </Panel>
      </Page>
    )
  }

  const connector = ctx.connectors.get(connectorId)
  if (!connector) notFound()
  const settings = ctx.connectors.settings(connector.id)
  const signIn = deviceFlowOf(connector) !== undefined

  return (
    <Page>
      <PageHeader
        back={{ href: '/connections/new', label: t('connections.new.title') }}
        title={t('connections.new.titleFor', { connector: connector.name })}
      />
      {settings.ok ? (
        <Section title={t('connections.new.formTitle')} className="max-w-[35rem]">
          <SectionContent>
            <NewConnectionForm
              connectorId={connector.id}
              configFields={describeFields('config', connector.configSchema)}
              // A connector that signs in gets its credentials from the sign-in, never from a form.
              credentialsFields={signIn ? [] : describeFields('credentials', connector.credentialsSchema)}
              signIn={signIn ? { connector: connector.name } : null}
            />
          </SectionContent>
        </Section>
      ) : (
        <div className="max-w-[35rem]">
          <Notice tone="warning" title={t('connections.new.notConfigured')}>
            <p>
              {t('connections.new.notConfiguredHint')} <Variables names={settings.variables} />
            </p>
          </Notice>
        </div>
      )}
    </Page>
  )
}
