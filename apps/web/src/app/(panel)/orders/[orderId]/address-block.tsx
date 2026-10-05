import type { Address } from '@hanza/connector-sdk'

export function AddressBlock({ title, address }: { title: string; address: Address | null }) {
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
              tel. {address.phone}
            </>
          ) : null}
          {address.taxId ? (
            <>
              <br />
              NIP: {address.taxId}
            </>
          ) : null}
        </address>
      ) : (
        <p className="mt-1 text-sm text-muted">Nie podano.</p>
      )}
    </div>
  )
}
