import { getFamily } from '@hanza/core'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { EmptyState, Section, linkClass } from '@/components/section'
import { getT } from '@/i18n/server'
import { getContext } from '@/lib/context'
import { getFormatters } from '@/lib/formatters'
import { requireTenant } from '@/lib/session'
import { AddProductForm, DeleteFamilyForm, MemberValuesForm, RemoveMemberForm, RenameForm } from './forms'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('families.detail.title') }
}

export default async function FamilyPage({ params }: { params: Promise<{ familyId: string }> }) {
  const { organizationId } = await requireTenant()
  const [t, format] = await Promise.all([getT(), getFormatters()])
  const { familyId } = await params
  const family = await getFamily(getContext(), organizationId, familyId)
  if (!family) notFound()

  return (
    <div className="space-y-6">
      <div>
        <Link href="/families" className={linkClass}>
          ← {t('families.title')}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{family.name}</h1>
        <p className="text-sm text-muted">
          {t('families.detail.attributesLine', { attributes: family.attributes.join(', ') })} · {t('families.productCount', { count: family.members.length })}
        </p>
      </div>

      <Section title={t('families.detail.renameTitle')} description={t('families.detail.renameDescription')}>
        <div className="px-5 py-4">
          <RenameForm familyId={family.id} name={family.name} />
        </div>
      </Section>

      <Section title={t('families.detail.membersTitle')} description={t('families.detail.membersDescription')}>
        {family.members.length === 0 ? (
          <EmptyState>{t('families.detail.membersEmpty')}</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {family.members.map((member) => (
              <li key={member.productId} className="flex flex-wrap items-end justify-between gap-4 px-5 py-4">
                <div className="min-w-48">
                  <Link href={`/products/${member.productId}`} className={`${linkClass} font-mono`}>
                    {member.sku}
                  </Link>
                  <p className="text-sm">{member.name}</p>
                  <p className="text-xs text-muted">
                    {t('families.detail.columns.available')}: {format.number(member.available)}
                  </p>
                </div>
                <MemberValuesForm
                  productId={member.productId}
                  sku={member.sku}
                  attributes={family.attributes.map((name) => ({ name, value: member.values[name] ?? '' }))}
                />
                <RemoveMemberForm productId={member.productId} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t('families.detail.addTitle')} description={t('families.detail.addDescription')}>
        <div className="px-5 py-4">
          <AddProductForm familyId={family.id} attributes={family.attributes} />
        </div>
      </Section>

      <Section title={t('families.detail.deleteTitle')} description={t('families.detail.deleteDescription')}>
        <div className="px-5 py-4">
          <DeleteFamilyForm familyId={family.id} />
        </div>
      </Section>
    </div>
  )
}
