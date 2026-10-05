import { listOffers } from '@hanza/core'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Pagination } from '@/components/pagination'
import { EmptyState, Section, linkClass, rowClass, tableClass, tdClass, thClass } from '@/components/section'
import { getContext } from '@/lib/context'
import { formatDateTime } from '@/lib/format'
import { outOfRangeRedirect, pageWindow, parsePage } from '@/lib/pagination'
import { safeHttpUrl } from '@/lib/safe-url'
import { requireTenant } from '@/lib/session'
import { CREATE_PRODUCTS_FORM_ID, CreateProductsForm } from './create-products-form'
import { LinkOfferForm } from './link-offer-form'
import { SelectAll } from './select-all'

export const dynamic = 'force-dynamic'

export default async function UnlinkedOffersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { organizationId } = await requireTenant()
  const page = parsePage((await searchParams).page)
  const { total, items } = await listOffers(getContext(), organizationId, { linked: false, ...pageWindow(page) })
  const outOfRange = outOfRangeRedirect(page, total, '/products/offers')
  if (outOfRange) redirect(outOfRange)

  return (
    <div className="space-y-6">
      <div>
        <Link href="/products" className={linkClass}>
          ← Produkty
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Oferty bez produktu</h1>
        <p className="mt-1 text-muted">Oferty pobrane z kanałów, których SKU nie pasuje do żadnego produktu.</p>
      </div>

      <Section title="Utwórz produkty z ofert" description="Zaznacz oferty z SKU w tabeli. Produkt dostanie SKU i nazwę oferty oraz stan 0.">
        <div className="px-5 py-4">
          <CreateProductsForm offers={items.map((offer) => ({ id: offer.id, name: offer.name }))} />
        </div>
      </Section>

      <div className="rounded-lg border border-line bg-white">
        {total === 0 ? (
          <EmptyState>Wszystkie oferty mają produkty. Nowe oferty pojawią się po synchronizacji połączenia.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th scope="col" className={thClass}>
                    <SelectAll />
                  </th>
                  <th scope="col" className={thClass}>Połączenie</th>
                  <th scope="col" className={thClass}>Oferta</th>
                  <th scope="col" className={thClass}>SKU</th>
                  <th scope="col" className={thClass}>Widziana</th>
                  <th scope="col" className={thClass}>Połącz ręcznie</th>
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
                            aria-label={`Zaznacz ofertę ${offer.name}`}
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
                      <td className={`${tdClass} font-mono`}>{offer.sku ?? <span className="font-sans text-muted">brak</span>}</td>
                      <td className={tdClass}>{formatDateTime(offer.lastSeenAt)}</td>
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
