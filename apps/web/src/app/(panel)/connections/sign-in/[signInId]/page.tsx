import { deviceFlowOf } from '@hanza/connector-sdk'
import { getConnection, getSignIn } from '@hanza/core'
import { ExternalLink, Hourglass } from 'lucide-react'
import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { ActionForm } from '@/components/action-form'
import { buttonClass } from '@/components/button-class'
import { ActionButton } from '@/components/form'
import { Notice } from '@/components/notice'
import { PageHeader } from '@/components/page-header'
import { Page } from '@/components/page-layout'
import { Section, SectionContent } from '@/components/section'
import type { Tone } from '@/components/tone'
import { getT } from '@/i18n/server'
import { getContext } from '@/lib/context'
import { getFormatters } from '@/lib/formatters'
import { requireTenant } from '@/lib/session'
import { formatUserCode, isSignInOpen, signInLink } from '@/lib/sign-in'
import { cn } from '@/lib/utils'
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
  const code = view.status === 'pending' ? view.userCode : null

  // How the sign-in ended: a refusal or a wrong account is an error, an expired code only ran out of time,
  // and a cancelled one is what the person asked for.
  const ended = ((): { tone: Tone; text: string } | null => {
    const values = { connector: connectorName, account: view.accountLabel ?? '' }
    switch (view.status) {
      case 'denied':
        return { tone: 'critical', text: t('connections.signIn.denied', values) }
      case 'expired':
        return { tone: 'warning', text: t('connections.signIn.expired') }
      case 'failed':
        return { tone: 'critical', text: t('connections.signIn.failed') }
      case 'account_mismatch':
        return {
          tone: 'critical',
          text: view.accountLabel
            ? t('connections.signIn.account_mismatch', values)
            : t('connections.signIn.account_mismatch_unknown', { connector: connectorName }),
        }
      case 'account_in_use':
        return { tone: 'critical', text: t('connections.signIn.account_in_use', values) }
      case 'cancelled':
        return { tone: 'neutral', text: t('connections.signIn.cancelled') }
      case 'approved':
        return { tone: 'success', text: t('connections.signIn.approved') }
      default:
        return null
    }
  })()

  const retry =
    view.status !== 'approved' ? (
      <ActionForm action={retrySignInAction} className="grid gap-2">
        <input type="hidden" name="signInId" value={view.id} />
        <ActionButton pendingLabel={t('connections.signIn.retrying')} className="justify-self-start">
          {t('connections.signIn.tryAgain')}
        </ActionButton>
      </ActionForm>
    ) : undefined

  return (
    <Page>
      {open ? <AutoRefresh everyMs={REFRESH_EVERY_MS} /> : null}
      <PageHeader
        back={existing ? { href: `/connections/${existing.id}`, label: existing.name } : { href: '/connections', label: t('connections.title') }}
        title={heading}
        meta={view.name ? t('connections.signIn.connectionName', { name: view.name }) : undefined}
      />

      {/* One narrow column: the page is a single task, done mostly in another tab. */}
      <div className="flex max-w-[35rem] flex-col gap-5">
        {open && !code ? (
          <Notice role="status" icon={Hourglass}>
            {t('connections.signIn.starting')}
          </Notice>
        ) : null}

        {code ? (
          <Section title={t('connections.signIn.codeLabel')}>
            <SectionContent className="grid gap-4">
              <div>
                {/* `select-all`: one click takes the whole code, for those who paste it instead of typing it. */}
                <p className="rounded-lg bg-muted px-4 py-5 text-center font-mono text-3xl leading-10 font-semibold tracking-[0.12em] break-words select-all">
                  {formatUserCode(code)}
                </p>
                <p className="mt-2 text-meta text-muted-foreground tabular-nums">
                  {t('connections.signIn.validUntil', { time: format.dateTime(view.expiresAt) })}
                </p>
              </div>
              <ol className="grid list-decimal gap-1.5 pl-5 text-sm marker:text-muted-foreground marker:tabular-nums">
                <li>{t('connections.signIn.steps.open', { connector: connectorName })}</li>
                <li>{t('connections.signIn.steps.enter')}</li>
                <li>{t('connections.signIn.steps.allow')}</li>
              </ol>
              {link ? (
                <a
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  // A connector's name can be long: the label may wrap rather than push the card wider than a phone.
                  className={cn(buttonClass('primary'), 'h-auto min-h-8 max-w-full justify-self-start py-1.5 text-center whitespace-normal')}
                >
                  {t('connections.signIn.open', { connector: connectorName })}
                  <ExternalLink aria-hidden="true" />
                </a>
              ) : (
                <p className="text-sm">{t('connections.signIn.noLink', { connector: connectorName })}</p>
              )}
              <Notice role="status" icon={Hourglass}>
                {t('connections.signIn.waiting')}
              </Notice>
            </SectionContent>
          </Section>
        ) : null}

        {open ? (
          <ActionForm action={cancelSignInAction} className="grid gap-2">
            <input type="hidden" name="signInId" value={view.id} />
            <ActionButton variant="secondary" pendingLabel={t('connections.signIn.cancelling')} className="justify-self-start">
              {t('connections.signIn.cancel')}
            </ActionButton>
          </ActionForm>
        ) : ended ? (
          <Notice tone={ended.tone} actions={retry}>
            <p role="alert">{ended.text}</p>
          </Notice>
        ) : (
          retry
        )}
      </div>
    </Page>
  )
}
