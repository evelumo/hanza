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
          {connectors.map((connector) => (
            <li key={connector.id}>
              <Link
                href={`/connections/new?connector=${encodeURIComponent(connector.id)}`}
                className="flex items-center justify-between gap-3 px-5 py-4 hover:bg-canvas focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <span className="font-medium">{connector.name}</span>
                <span className="text-sm text-muted">{labelOrRaw(t, 'labels.connectorKind', connector.kind)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  const connector = ctx.connectors.get(connectorId)
  if (!connector) notFound()

  return (
    <div className="max-w-md space-y-6">
      <div>
        <Link href="/connections/new" className={linkClass}>
          ← {t('connections.new.backToChoice')}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{t('connections.new.titleFor', { connector: connector.name })}</h1>
      </div>
      <div className="rounded-lg border border-line bg-white p-5">
        <NewConnectionForm
          connectorId={connector.id}
          configFields={describeFields('config', connector.configSchema)}
          credentialsFields={describeFields('credentials', connector.credentialsSchema)}
        />
      </div>
    </div>
  )
}
