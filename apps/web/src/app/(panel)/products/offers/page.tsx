import { listOffers } from '@hanza/core'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Pagination } from '@/components/pagination'
import { EmptyState, Section, linkClass, rowClass, tableClass, tdClass, thClass } from '@/components/section'
import { getT } from '@/i18n/server'
import { getContext } from '@/lib/context'
import { getFormatters } from '@/lib/formatters'
import { outOfRangeRedirect, pageWindow, parsePage } from '@/lib/pagination'
import { publicationLabel } from '@/lib/offer-push-status'
import { safeHttpUrl } from '@/lib/safe-url'
import { requireTenant } from '@/lib/session'
import { CREATE_PRODUCTS_FORM_ID, CreateProductsForm } from './create-products-form'
import { LinkOfferForm } from './link-offer-form'
import { SelectAll } from './select-all'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('offers.title') }
}

export default async function UnlinkedOffersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { organizationId } = await requireTenant()
  const [t, format] = await Promise.all([getT(), getFormatters()])
  const page = parsePage((await searchParams).page)
  const { total, items } = await listOffers(getContext(), organizationId, { linked: false, ...pageWindow(page) })
  const outOfRange = outOfRangeRedirect(page, total, '/products/offers')
  if (outOfRange) redirect(outOfRange)

  return (
    <div className="space-y-6">
      <div>
        <Link href="/products" className={linkClass}>
          ← {t('products.title')}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{t('offers.title')}</h1>
        <p className="mt-1 text-muted">{t('offers.description')}</p>
      </div>

      <Section title={t('offers.createTitle')} description={t('offers.createDescription')}>
        <div className="px-5 py-4">
          <CreateProductsForm offers={items.map((offer) => ({ id: offer.id, name: offer.name }))} />
        </div>
      </Section>

      <div className="rounded-lg border border-line bg-white">
        {total === 0 ? (
          <EmptyState>{t('offers.empty')}</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th scope="col" className={thClass}>
                    <SelectAll />
                  </th>
                  <th scope="col" className={thClass}>{t('offers.columns.connection')}</th>
                  <th scope="col" className={thClass}>{t('offers.columns.offer')}</th>
                  <th scope="col" className={thClass}>{t('offers.columns.sku')}</th>
                  <th scope="col" className={thClass}>{t('offers.columns.publication')}</th>
                  <th scope="col" className={thClass}>{t('offers.columns.seen')}</th>
                  <th scope="col" className={thClass}>{t('offers.columns.link')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((offer) => {
                  const href = safeHttpUrl(offer.url)
                  return (
                    <tr key={offer.id} className={rowClass}>
                      <td className={tdClass}>
                        {offer.sku ? (
                          <input
                            type="checkbox"
                            name="offerIds"
                            value={offer.id}
                            form={CREATE_PRODUCTS_FORM_ID}
                            aria-label={t('offers.selectOffer', { name: offer.name })}
                            className="size-4 accent-accent"
                          />
                        ) : null}
                      </td>
                      <td className={tdClass}>{offer.connectionName}</td>
                      <td className={tdClass}>
                        {href ? (
                          <a href={href} target="_blank" rel="noopener noreferrer" className={linkClass}>
                            {offer.name}
                          </a>
                        ) : (
                          offer.name
                        )}
                        <span className="block font-mono text-xs text-muted">{offer.externalId}</span>
                      </td>
                      <td className={`${tdClass} font-mono`}>{offer.sku ?? <span className="font-sans text-muted">{t('common.none')}</span>}</td>
                      <td className={tdClass}>{publicationLabel(t, offer.publication)}</td>
                      <td className={tdClass}>{format.dateTime(offer.lastSeenAt)}</td>
                      <td className={tdClass}>
                        <LinkOfferForm offerId={offer.id} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Pagination page={page} total={total} basePath="/products/offers" />
    </div>
  )
}
