import type { Metadata } from 'next'
import { PageHeader } from '@/components/page-header'
import { Page } from '@/components/page-layout'
import { Section, SectionContent } from '@/components/section'
import { getT } from '@/i18n/server'
import { requireTenant } from '@/lib/session'
import { NewProductForm } from './new-product-form'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('products.new.title') }
}

export default async function NewProductPage() {
  await requireTenant()
  const t = await getT()
  return (
    <Page>
      <PageHeader back={{ href: '/products', label: t('products.title') }} title={t('products.new.title')} />
      <Section title={t('products.new.sectionTitle')} className="max-w-[35rem]">
        <SectionContent>
          <NewProductForm />
        </SectionContent>
      </Section>
    </Page>
  )
}
