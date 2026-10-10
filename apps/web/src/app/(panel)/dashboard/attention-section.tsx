import { CircleAlert, CircleCheck, KeyRound, OctagonAlert, type LucideIcon } from 'lucide-react'
import { LinkList, LinkRow } from '@/components/link-list'
import { Section } from '@/components/section'
import { toneTextClass, type Tone } from '@/components/tone'
import type { Translator } from '@/i18n/types'
import { useT } from '@/i18n/use-t'
import { attentionReasonLabel, streamLabel, syncErrorLabel } from '@/lib/labels'
import { cn } from '@/lib/utils'
import type { AttentionItem } from './overview'

// The same tones and shapes the badges use for these states elsewhere in the panel.
const look: Record<AttentionItem['kind'], { tone: Tone; icon: LucideIcon }> = {
  connection_failing: { tone: 'critical', icon: OctagonAlert },
  connection_sign_in: { tone: 'warning', icon: KeyRound },
  orders: { tone: 'attention', icon: CircleAlert },
  unlinked_offers: { tone: 'attention', icon: CircleAlert },
  stock_unset_offers: { tone: 'attention', icon: CircleAlert },
}

function describe(item: AttentionItem, t: Translator): { title: string; detail: string } {
  switch (item.kind) {
    case 'connection_failing':
      return {
        title: t('dashboard.attention.connectionFailing', { name: item.name }),
        detail:
          item.errors.length > 0
            ? item.errors
                .map((error) => t('dashboard.attention.streamError', { stream: streamLabel(t, error.stream), error: syncErrorLabel(t, error.kind) }))
                .join(' · ')
            : t('dashboard.attention.connectionFailingHint'),
      }
    case 'connection_sign_in':
      return { title: t('dashboard.attention.connectionSignIn', { name: item.name }), detail: t('dashboard.attention.connectionSignInHint') }
    case 'orders':
      return {
        title: t('dashboard.attention.orders', { count: item.total }),
        detail: item.reasons
          .map(({ reason, count }) => t('dashboard.attention.reason', { reason: attentionReasonLabel(t, reason), count }))
          .join(' · '),
      }
    case 'unlinked_offers':
      return { title: t('dashboard.attention.unlinkedOffers', { count: item.count }), detail: t('dashboard.attention.unlinkedOffersHint') }
    case 'stock_unset_offers':
      return { title: t('dashboard.attention.stockUnsetOffers', { count: item.count }), detail: t('dashboard.attention.stockUnsetOffersHint') }
  }
}

/** Always on the page: with nothing waiting it says so, so an empty list is never mistaken for a missing one. */
export function AttentionSection({ items }: { items: AttentionItem[] }) {
  const t = useT()
  return (
    <Section title={t('dashboard.attention.title')}>
      {items.length === 0 ? (
        <p className="flex items-center gap-3 px-4 py-3.5 text-sm">
          <CircleCheck className="size-4 shrink-0 text-success" aria-hidden="true" />
          {t('dashboard.attention.none')}
        </p>
      ) : (
        <LinkList>
          {items.map((item) => {
            const { tone, icon: Icon } = look[item.kind]
            const { title, detail } = describe(item, t)
            return (
              <LinkRow
                key={`${item.kind}:${item.href}`}
                href={item.href}
                leading={<Icon className={cn('size-4', toneTextClass[tone])} aria-hidden="true" />}
                title={title}
                detail={detail}
              />
            )
          })}
        </LinkList>
      )}
    </Section>
  )
}
