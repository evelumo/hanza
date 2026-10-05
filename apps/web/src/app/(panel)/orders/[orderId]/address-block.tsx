import type { Address } from '@hanza/connector-sdk'
import { useT } from '@/i18n/use-t'

export function AddressBlock({ title, address }: { title: string; address: Address | null }) {
  const t = useT()
  return (
    <div>
      <h3 className="text-sm font-medium text-muted">{title}</h3>
      {address ? (
        <address className="mt-1 text-sm not-italic leading-6">
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
      ) : (
        <p className="mt-1 text-sm text-muted">{t('orders.detail.addressMissing')}</p>
      )}
    </div>
  )
}
