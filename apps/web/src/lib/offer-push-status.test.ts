import { describe, expect, it } from 'vitest'
import { catalogues } from '@/i18n/catalogues'
import { translatorFor } from '@/i18n/testing'
import { publicationLabel, rejectionText, stockStatusText } from './offer-push-status'

const en = translatorFor('en')
const pl = translatorFor('pl')
const dateTime = () => '06/10/2026, 12:00'
const at = new Date('2026-10-06T10:00:00Z')

describe('publicationLabel', () => {
  it('names the publication, the sold-out reason, and an unknown one', () => {
    expect(publicationLabel(en, { status: 'active', endedReason: null })).toBe('Active')
    expect(publicationLabel(en, { status: 'ended', endedReason: 'sold_out' })).toBe('Ended (sold out)')
    expect(publicationLabel(en, { status: 'ended', endedReason: 'other' })).toBe('Ended')
    expect(publicationLabel(en, null)).toBe('Unknown')
    expect(publicationLabel(pl, { status: 'inactive', endedReason: null })).toBe(catalogues.pl.labels.publication.inactive)
  })
})

describe('rejectionText', () => {
  it("quotes the Channel's code and explains Hanza's own one", () => {
    expect(rejectionText(en, { code: 'OFFER_NOT_FOUND', at })).toBe('Rejected by the channel: OFFER_NOT_FOUND.')
    expect(rejectionText(en, { code: 'offer_ended', at })).toBe(catalogues.en.offerPush.offerEnded)
    expect(rejectionText(pl, { code: 'offer_ended', at })).toBe(catalogues.pl.offerPush.offerEnded)
  })
})

describe('stockStatusText', () => {
  const offer = { stockStatus: 'pushed' as const, stockRejection: null, lastPushedAvailable: 3, lastPushedAt: at }

  it('says what was sent, or why not', () => {
    expect(stockStatusText(en, offer, dateTime)).toBe('3 units sent 06/10/2026, 12:00.')
    expect(stockStatusText(pl, offer, dateTime)).toBe('Wysłano 3 sztuki 06/10/2026, 12:00.')
    expect(stockStatusText(en, { ...offer, stockStatus: 'rejected', stockRejection: { code: 'LOCKED', at } }, dateTime)).toBe(
      'Rejected by the channel: LOCKED.',
    )
    for (const status of ['not_linked', 'pending', 'not_sent'] as const) {
      expect(stockStatusText(en, { ...offer, stockStatus: status }, dateTime)).toBe(catalogues.en.offerPush.stock[status])
      expect(stockStatusText(pl, { ...offer, stockStatus: status }, dateTime)).toBe(catalogues.pl.offerPush.stock[status])
    }
  })
})
