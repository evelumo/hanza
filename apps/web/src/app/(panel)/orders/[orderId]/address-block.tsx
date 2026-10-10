import type { Address } from '@hanza/connector-sdk'
import { useT } from '@/i18n/use-t'

/** The value of an address in a description list; its term (which address it is) comes from the caller. */
export function AddressBlock({ address }: { address: Address | null }) {
  const t = useT()
  if (!address) return <span className="text-muted-foreground">{t('orders.detail.addressMissing')}</span>
  return (
    <address className="leading-5 not-italic">
      {address.name}
      {address.company ? <br /> : null}
      {address.company}
      <br />
      {address.street}
      <br />
      {address.postalCode} {address.city}, {address.countryCode}
      {address.phone ? (
        <>
          <br />
          {t('orders.detail.phone', { phone: address.phone })}
        </>
      ) : null}
      {address.taxId ? (
        <>
          <br />
          {t('orders.detail.taxId', { taxId: address.taxId })}
        </>
      ) : null}
    </address>
  )
}
