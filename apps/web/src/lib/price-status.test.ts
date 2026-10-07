import { describe, expect, it } from 'vitest'
import { catalogues } from '@/i18n/catalogues'
import { translatorFor } from '@/i18n/testing'
import { isPriceBlocked, priceStatusText } from './price-status'

const dateTime = () => '05/10/2026, 12:00'
const offer = {
  priceStatus: 'pushed' as const,
  effectivePrice: { amount: '45', currency: 'PLN' },
  channelPrice: { amount: '9.99', currency: 'EUR' },
  lastPricePushedAt: new Date('2026-10-05T10:00:00Z'),
}

describe('priceStatusText', () => {
  it('names both currencies when they differ', () => {
    expect(priceStatusText(translatorFor('en'), { ...offer, priceStatus: 'currency_mismatch' }, dateTime)).toBe(
      'Not sent: the channel sells this offer in EUR and the price is in PLN.',
    )
    expect(priceStatusText(translatorFor('pl'), { ...offer, priceStatus: 'currency_mismatch' }, dateTime)).toBe(
      'Nie wysłano: kanał sprzedaje tę ofertę w EUR, a cena jest w PLN.',
    )
  })

  it('dates a sent price', () => {
    expect(priceStatusText(translatorFor('en'), offer, dateTime)).toBe('Sent 05/10/2026, 12:00.')
  })

  it.each(['not_linked', 'unsupported', 'no_price', 'currency_unknown', 'pending'] as const)('has a sentence for %s in both languages', (status) => {
    expect(priceStatusText(translatorFor('en'), { ...offer, priceStatus: status }, dateTime)).toBe(catalogues.en.prices.status[status])
    expect(priceStatusText(translatorFor('pl'), { ...offer, priceStatus: status }, dateTime)).toBe(catalogues.pl.prices.status[status])
  })
})

describe('isPriceBlocked', () => {
  it('is true only for the currency problems a person can fix', () => {
    expect(isPriceBlocked('currency_mismatch')).toBe(true)
    expect(isPriceBlocked('currency_unknown')).toBe(true)
    expect(isPriceBlocked('no_price')).toBe(false)
    expect(isPriceBlocked('pushed')).toBe(false)
  })
})

describe('rejected prices', () => {
  const rejected = { ...offer, priceStatus: 'rejected' as const }

  it('shows the Channel code, and is shown as blocked', () => {
    const at = new Date('2026-10-06T10:00:00Z')
    expect(priceStatusText(translatorFor('en'), { ...rejected, priceRejection: { code: 'PRICE_TOO_LOW', at } }, dateTime)).toBe(
      'Rejected by the channel: PRICE_TOO_LOW.',
    )
    expect(priceStatusText(translatorFor('pl'), { ...rejected, priceRejection: { code: 'PRICE_TOO_LOW', at } }, dateTime)).toBe(
      'Odrzucone przez kanał: PRICE_TOO_LOW.',
    )
    expect(priceStatusText(translatorFor('en'), rejected, dateTime)).toBe(catalogues.en.prices.status.pending)
    expect(isPriceBlocked('rejected')).toBe(true)
  })
})
