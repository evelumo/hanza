import { PermanentError } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { listingOfferSchema, productOfferSchema } from '../api/offers'
import type { ListingOfferPayload } from '../testing/samples'
import { offers, productOffers, sampleListingOffer } from '../testing/samples'
import { endedReasonOf, mapOffer, needsEndedByLookup } from './offer'

const site = { siteBaseUrl: 'https://allegro.pl' }

function parse(payload: ListingOfferPayload) {
  return listingOfferSchema.parse(payload)
}

describe('mapOffer', () => {
  it('maps a buy-now Offer', () => {
    expect(mapOffer(parse(offers.buyNow), site)).toEqual({
      externalId: '7834566001',
      sku: 'MUG-350-WHT',
      name: 'Ceramic mug 350 ml, white',
      url: 'https://allegro.pl/oferta/7834566001',
      price: { amount: '39.99', currency: 'PLN' },
      status: 'active',
    })
  })

  it('builds the URL on the sandbox site, without a doubled slash', () => {
    const offer = mapOffer(parse(offers.buyNow), { siteBaseUrl: 'https://allegro.pl.allegrosandbox.pl/' })
    expect(offer?.url).toBe('https://allegro.pl.allegrosandbox.pl/oferta/7834566001')
  })

  it('reports no price for an auction', () => {
    expect(mapOffer(parse(offers.auction), site)).toMatchObject({ externalId: '7834566003', sku: null, price: null })
  })

  it('keeps the price of an advertisement and upper-cases its currency', () => {
    const payload = sampleListingOffer({ sellingMode: { format: 'ADVERTISEMENT', price: { amount: '1200', currency: 'pln' } } })
    expect(mapOffer(parse(payload), site)?.price).toEqual({ amount: '1200', currency: 'PLN' })
  })

  it.each([
    ['too many decimals', { amount: '39.99999', currency: 'PLN' }],
    ['a negative amount', { amount: '-1.00', currency: 'PLN' }],
    ['a currency that is not ISO 4217', { amount: '39.99', currency: 'ZŁ' }],
  ])('reports no price for %s instead of failing the page', (_label, price) => {
    const payload = sampleListingOffer({ sellingMode: { format: 'BUY_NOW', price } })
    expect(mapOffer(parse(payload), site)?.price).toBeNull()
  })

  it('reports no price for a selling format it does not know', () => {
    const payload = sampleListingOffer({ sellingMode: { format: 'RAFFLE', price: { amount: '10.00', currency: 'PLN' } } })
    expect(mapOffer(parse(payload), site)?.price).toBeNull()
  })

  it('maps an Offer without an external id to sku null, also for an empty one', () => {
    expect(mapOffer(parse(offers.withoutSignature), site)?.sku).toBeNull()
    expect(mapOffer(parse(sampleListingOffer({ external: { id: '' } })), site)?.sku).toBeNull()
  })

  it('skips an Offer fulfilled by Allegro', () => {
    expect(mapOffer(parse(offers.oneFulfillment), site)).toBeNull()
  })

  it.each([
    ['ACTIVE', 'active'],
    ['ACTIVATING', 'active'],
    ['INACTIVE', 'inactive'],
  ])('maps the publication %s to %s', (status, expected) => {
    const offer = mapOffer(parse(sampleListingOffer({ publication: { status } })), site)
    expect(offer?.status).toBe(expected)
    expect(offer).not.toHaveProperty('endedReason')
  })

  it('maps a draft to inactive', () => {
    expect(mapOffer(parse(offers.draft), site)?.status).toBe('inactive')
  })

  it('leaves the status out when Allegro sends one it does not know, or none', () => {
    expect(mapOffer(parse(sampleListingOffer({ publication: { status: 'ARCHIVED' } })), site)).not.toHaveProperty('status')
    expect(mapOffer(parse(sampleListingOffer({ publication: null })), site)).not.toHaveProperty('status')
  })

  it('maps an ended Offer with stock left to other, without a lookup', () => {
    const offer = parse(offers.endedByUser)
    expect(needsEndedByLookup(offer)).toBe(false)
    expect(mapOffer(offer, site)).toMatchObject({ status: 'ended', endedReason: 'other' })
  })

  it('maps a sold-out Offer with the endedBy of its product offer', () => {
    const offer = parse(offers.endedSoldOut)
    expect(needsEndedByLookup(offer)).toBe(true)
    const endedBy = productOfferSchema.parse(productOffers.endedSoldOut).publication?.endedBy
    expect(mapOffer(offer, { ...site, endedBy })).toMatchObject({ status: 'ended', endedReason: 'sold_out' })
  })

  it('maps an ended Offer without stock that ended for another reason to other', () => {
    const offer = parse(offers.endedSoldOut)
    expect(mapOffer(offer, { ...site, endedBy: 'USER' })?.endedReason).toBe('other')
    expect(mapOffer(offer, { ...site, endedBy: null })?.endedReason).toBe('other')
  })

  it('leaves the reason out of an ended Offer without stock that was not looked up', () => {
    const offer = mapOffer(parse(offers.endedSoldOut), site)
    expect(offer?.status).toBe('ended')
    expect(offer).not.toHaveProperty('endedReason')
  })

  it('ignores an endedBy given for an Offer that did not end', () => {
    expect(mapOffer(parse(offers.buyNow), { ...site, endedBy: 'EMPTY_STOCK' })).not.toHaveProperty('endedReason')
  })

  it('throws a PermanentError naming the field when the Offer has no name', () => {
    expect(() => mapOffer(parse(sampleListingOffer({ name: '' })), site)).toThrow(PermanentError)
    expect(() => mapOffer(parse(sampleListingOffer({ name: '' })), site)).toThrow(
      'Allegro Offer 7834566001 cannot be mapped to an Offer (name)',
    )
  })
})

describe('needsEndedByLookup', () => {
  it.each([
    ['ended with no stock', { status: 'ENDED' }, { available: 0 }, true],
    ['ended without a stock figure', { status: 'ENDED' }, null, true],
    ['ended with stock left', { status: 'ENDED' }, { available: 2 }, false],
    ['active with no stock', { status: 'ACTIVE' }, { available: 0 }, false],
  ])('%s: %s', (_label, publication, stock, expected) => {
    expect(needsEndedByLookup(parse(sampleListingOffer({ publication, stock })))).toBe(expected)
  })
})

describe('endedReasonOf', () => {
  it.each([
    ['EMPTY_STOCK', 'sold_out'],
    ['USER', 'other'],
    ['ADMIN', 'other'],
    ['EXPIRATION', 'other'],
    ['PRODUCT_DETACHMENT', 'other'],
    ['ERROR', 'other'],
    ['VISIBILITY', 'other'],
    ['SOMETHING_NEW', 'other'],
    [null, 'other'],
    [undefined, 'other'],
  ])('maps %s to %s', (endedBy, expected) => {
    expect(endedReasonOf(endedBy)).toBe(expected)
  })
})
