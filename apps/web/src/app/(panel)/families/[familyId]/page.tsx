import { getFamily } from '@hanza/core'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { DataTable, DataTableBody, DataTableCell, DataTableHead, DataTableHeader, DataTableRow } from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { Page, PageColumns } from '@/components/page-layout'
import { Section, SectionContent } from '@/components/section'
import { TextLink } from '@/components/text-link'
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
    <Page>
      <PageHeader
        back={{ href: '/families', label: t('families.title') }}
        title={family.name}
        meta={
          <>
            {t('families.detail.attributesLine', { attributes: family.attributes.join(', ') })} · {t('families.productCount', { count: family.members.length })}
          </>
        }
      />

      <PageColumns
        aside={
          <>
            <Section title={t('families.detail.renameTitle')} description={t('families.detail.renameDescription')}>
              <SectionContent>
                <RenameForm familyId={family.id} name={family.name} />
              </SectionContent>
            </Section>

            <Section title={t('families.detail.deleteTitle')} description={t('families.detail.deleteDescription')} className="border-critical-border">
              <SectionContent>
                <DeleteFamilyForm familyId={family.id} />
              </SectionContent>
            </Section>
          </>
        }
      >
        <Section title={t('families.detail.membersTitle')} description={t('families.detail.membersDescription')}>
          {family.members.length === 0 ? (
            <EmptyState>{t('families.detail.membersEmpty')}</EmptyState>
          ) : (
            <DataTable align="top">
              <DataTableHeader>
                <DataTableHead>{t('families.detail.columns.product')}</DataTableHead>
                <DataTableHead numeric>{t('families.detail.columns.available')}</DataTableHead>
                <DataTableHead>{t('families.detail.columns.values')}</DataTableHead>
                <DataTableHead>
                  <span className="sr-only">{t('families.detail.columns.actions')}</span>
                </DataTableHead>
              </DataTableHeader>
              <DataTableBody>
                {family.members.map((member) => (
                  <DataTableRow key={member.productId}>
                    <DataTableCell narrow="primary" className="@2xl/table:min-w-40">
                      <TextLink href={`/products/${member.productId}`} mono>
                        {member.sku}
                      </TextLink>
                      <p className="break-words">{member.name}</p>
                    </DataTableCell>
                    <DataTableCell numeric narrow="end" narrowLabel={t('families.detail.columns.available')}>
                      {format.number(member.available)}
                    </DataTableCell>
                    <DataTableCell className="@2xl/table:min-w-72">
                      <MemberValuesForm
                        productId={member.productId}
                        sku={member.sku}
                        attributes={family.attributes.map((name) => ({ name, value: member.values[name] ?? '' }))}
                      />
                    </DataTableCell>
                    <DataTableCell>
                      <RemoveMemberForm productId={member.productId} />
                    </DataTableCell>
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>
          )}
        </Section>

        <Section title={t('families.detail.addTitle')} description={t('families.detail.addDescription')}>
          <SectionContent>
            <AddProductForm familyId={family.id} attributes={family.attributes} />
          </SectionContent>
        </Section>
      </PageColumns>
    </Page>
  )
}
