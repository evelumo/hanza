import { Circle, CircleCheck } from 'lucide-react'
import { LinkList, LinkRow } from '@/components/link-list'
import { Section } from '@/components/section'
import { useT } from '@/i18n/use-t'
import type { SetupStep } from './overview'

/** The first-run checklist. A finished step shrinks to its name, so the next thing to do is the one that reads. */
export function SetupSection({ steps }: { steps: SetupStep[] }) {
  const t = useT()
  const done = steps.filter((step) => step.done).length
  return (
    <Section
      title={t('dashboard.setup.title')}
      description={t('dashboard.setup.description')}
      actions={<span className="text-meta text-muted-foreground tabular-nums">{t('dashboard.setup.progress', { done, total: steps.length })}</span>}
    >
      <LinkList ordered>
        {steps.map((step) =>
          step.done ? (
            <LinkRow
              key={step.id}
              href={step.href}
              leading={<CircleCheck className="size-4 text-success" aria-hidden="true" />}
              title={<span className="font-normal text-muted-foreground">{t(`dashboard.setup.steps.${step.id}.title`)}</span>}
              trailing={<span className="shrink-0 text-meta text-muted-foreground">{t('dashboard.setup.done')}</span>}
            />
          ) : (
            <LinkRow
              key={step.id}
              href={step.href}
              leading={<Circle className="size-4 text-muted-foreground" aria-hidden="true" />}
              title={t(`dashboard.setup.steps.${step.id}.title`)}
              detail={t(`dashboard.setup.steps.${step.id}.description`)}
            />
          ),
        )}
      </LinkList>
    </Section>
  )
}
