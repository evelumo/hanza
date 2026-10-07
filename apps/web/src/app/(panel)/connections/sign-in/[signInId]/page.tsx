import { deviceFlowOf } from '@hanza/connector-sdk'
import { getConnection, getSignIn } from '@hanza/core'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ActionForm } from '@/components/action-form'
import { buttonClass } from '@/components/button-class'
import { ActionButton } from '@/components/form'
import { Section, linkClass } from '@/components/section'
import { getT } from '@/i18n/server'
import { getContext } from '@/lib/context'
import { getFormatters } from '@/lib/formatters'
import { requireTenant } from '@/lib/session'
import { formatUserCode, isSignInOpen, signInLink } from '@/lib/sign-in'
import { cancelSignInAction, retrySignInAction } from '../../actions'
import { AutoRefresh } from './auto-refresh'

export const dynamic = 'force-dynamic'

const REFRESH_EVERY_MS = 2_000

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('connections.signIn.codeLabel') }
}

export default async function SignInPage({ params }: { params: Promise<{ signInId: string }> }) {
  const { organizationId } = await requireTenant()
  const [t, format] = await Promise.all([getT(), getFormatters()])
  const { signInId } = await params
  const ctx = getContext()
  const view = await getSignIn(ctx, organizationId, signInId)
  if (!view) notFound()
  if (view.status === 'approved' && view.connectionId) redirect(`/connections/${view.connectionId}`)

  const connector = ctx.connectors.get(view.connectorId)
  const connectorName = connector?.name ?? view.connectorId
  const hosts = connector ? (deviceFlowOf(connector)?.verificationHosts ?? []) : []
  const existing = view.reconnect && view.connectionId ? await getConnection(ctx, organizationId, view.connectionId) : null
  const heading = existing
    ? t('connections.signIn.titleAgain', { connector: connectorName, connection: existing.name })
    : t('connections.signIn.title', { connector: connectorName })
  const link = signInLink(view, hosts)
  const open = isSignInOpen(view.status)

  const ended = (() => {
    const values = { connector: connectorName, account: view.accountLabel ?? '' }
    switch (view.status) {
      case 'denied':
        return t('connections.signIn.denied', values)
      case 'expired':
        return t('connections.signIn.expired')
      case 'failed':
        return t('connections.signIn.failed')
      case 'account_mismatch':
        return view.accountLabel
          ? t('connections.signIn.account_mismatch', values)
          : t('connections.signIn.account_mismatch_unknown', { connector: connectorName })
      case 'account_in_use':
        return t('connections.signIn.account_in_use', values)
      case 'cancelled':
        return t('connections.signIn.cancelled')
      case 'approved':
        return t('connections.signIn.approved')
      default:
        return null
    }
  })()

  return (
    <div className="max-w-xl space-y-6">
      {open ? <AutoRefresh everyMs={REFRESH_EVERY_MS} /> : null}
      <div>
        <Link href={existing ? `/connections/${existing.id}` : '/connections'} className={linkClass}>
          ← {existing ? existing.name : t('connections.signIn.back')}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{heading}</h1>
        {view.name ? <p className="mt-1 text-sm text-muted">{t('connections.signIn.connectionName', { name: view.name })}</p> : null}
      </div>

      {view.status === 'starting' ? (
        <p role="status" className="rounded-lg border border-line bg-white px-5 py-4 text-sm">
          {t('connections.signIn.starting')}
        </p>
      ) : null}

      {view.status === 'pending' && view.userCode ? (
        <Section title={t('connections.signIn.codeLabel')} description={t('connections.signIn.instructions', { connector: connectorName })}>
          <div className="space-y-4 px-5 py-5">
            <p className="font-mono text-3xl font-semibold tracking-widest">{formatUserCode(view.userCode)}</p>
            {link ? (
              <a href={link} target="_blank" rel="noopener noreferrer" className={buttonClass('primary')}>
                {t('connections.signIn.open', { connector: connectorName })}
              </a>
            ) : (
              <p className="text-sm">{t('connections.signIn.noLink', { connector: connectorName })}</p>
            )}
            <p className="text-sm text-muted">{t('connections.signIn.validUntil', { time: format.dateTime(view.expiresAt) })}</p>
            <p role="status" className="text-sm">
              {t('connections.signIn.waiting')}
            </p>
          </div>
        </Section>
      ) : null}

      {open ? (
        <ActionForm action={cancelSignInAction}>
          <input type="hidden" name="signInId" value={view.id} />
          <ActionButton variant="secondary" pendingLabel={t('connections.signIn.cancelling')}>
            {t('connections.signIn.cancel')}
          </ActionButton>
        </ActionForm>
      ) : (
        <div className="space-y-4">
          {ended ? (
            <p role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {ended}
            </p>
          ) : null}
          {view.status !== 'approved' ? (
            <ActionForm action={retrySignInAction}>
              <input type="hidden" name="signInId" value={view.id} />
              <ActionButton pendingLabel={t('connections.signIn.retrying')}>{t('connections.signIn.tryAgain')}</ActionButton>
            </ActionForm>
          ) : null}
        </div>
      )}
    </div>
  )
}
