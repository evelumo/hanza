import { deviceFlowOf } from '@hanza/connector-sdk'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { linkClass } from '@/components/section'
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

export default async function NewConnectionPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireTenant()
  const t = await getT()
  const connectorId = firstParam((await searchParams).connector)
  const ctx = getContext()

  if (!connectorId) {
    const connectors = ctx.connectors.list()
    return (
      <div className="max-w-xl space-y-6">
        <div>
          <Link href="/connections" className={linkClass}>
            ← {t('connections.title')}
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">{t('connections.new.title')}</h1>
          <p className="mt-1 text-muted">{t('connections.new.description')}</p>
        </div>
        <ul className="divide-y divide-line rounded-lg border border-line bg-white">
          {connectors.map((connector) => {
            const settings = ctx.connectors.settings(connector.id)
            // Not set up on this installation: listed for the operator, but it cannot be connected.
            if (!settings.ok) {
              return (
                <li key={connector.id} className="px-5 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-muted">{connector.name}</span>
                    <span className="text-sm text-muted">{t('connections.new.notConfigured')}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted">{t('connections.new.notConfiguredHint', { variables: settings.variables.join(', ') })}</p>
                </li>
              )
            }
            return (
            <li key={connector.id}>
              <Link
                href={`/connections/new?connector=${encodeURIComponent(connector.id)}`}
                className="flex items-center justify-between gap-3 px-5 py-4 hover:bg-canvas focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <span className="font-medium">{connector.name}</span>
                <span className="text-sm text-muted">{labelOrRaw(t, 'labels.connectorKind', connector.kind)}</span>
              </Link>
            </li>
            )
          })}
        </ul>
      </div>
    )
  }

  const connector = ctx.connectors.get(connectorId)
  if (!connector) notFound()
  const settings = ctx.connectors.settings(connector.id)
  const signIn = deviceFlowOf(connector) !== undefined

  return (
    <div className="max-w-md space-y-6">
      <div>
        <Link href="/connections/new" className={linkClass}>
          ← {t('connections.new.backToChoice')}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{t('connections.new.titleFor', { connector: connector.name })}</h1>
      </div>
      <div className="rounded-lg border border-line bg-white p-5">
        {settings.ok ? (
          <NewConnectionForm
            connectorId={connector.id}
            configFields={describeFields('config', connector.configSchema)}
            // A connector that signs in gets its credentials from the sign-in, never from a form.
            credentialsFields={signIn ? [] : describeFields('credentials', connector.credentialsSchema)}
            signIn={signIn ? { connector: connector.name } : null}
          />
        ) : (
          <div role="alert" className="space-y-1 text-sm">
            <p className="font-medium">{t('connections.new.notConfigured')}</p>
            <p className="text-muted">{t('connections.new.notConfiguredHint', { variables: settings.variables.join(', ') })}</p>
          </div>
        )}
      </div>
    </div>
  )
}
