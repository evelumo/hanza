import type { Metadata } from 'next'
import { PageHeader } from '@/components/page-header'
import { Page } from '@/components/page-layout'
import { Section, SectionContent } from '@/components/section'
import { getT } from '@/i18n/server'
import { requireTenant } from '@/lib/session'
import { NewFamilyForm } from './new-family-form'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('families.new.title') }
}

export default async function NewFamilyPage() {
  await requireTenant()
  const t = await getT()
  return (
    <Page>
      <PageHeader back={{ href: '/families', label: t('families.title') }} title={t('families.new.title')} />
      <Section title={t('families.new.sectionTitle')} className="max-w-[35rem]">
        <SectionContent>
          <NewFamilyForm />
        </SectionContent>
      </Section>
    </Page>
  )
}
