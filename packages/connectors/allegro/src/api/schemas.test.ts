import { describe, expect, it } from 'vitest'
import { orderEventsPageSchema, orderEventStatsSchema } from './events'
import { listingOfferSchema, offersPageSchema, productOfferSchema } from './offers'
import { checkoutFormSchema, checkoutFormsPageSchema } from './orders'
import {
  forms,
  offers,
  productOffers,
  sampleCheckoutForm,
  sampleListingOffer,
  sampleOrderEvent,
  sampleProductOffer,
} from '../testing/samples'

describe('offer schemas', () => {
  it('parses a page of every sample Offer', () => {
    const page = offersPageSchema.parse({ offers: Object.values(offers), count: 7, totalCount: 1234 })
    expect(page.offers.map((offer) => offer.id)).toContain('7834566004')
    expect(page.totalCount).toBe(1234)
  })

  it('keeps only the modelled fields', () => {
    expect(listingOfferSchema.parse(sampleListingOffer())).toEqual({
      id: '7834566001',
      name: 'Ceramic mug 350 ml, white',
      sellingMode: { format: 'BUY_NOW', price: { amount: '39.99', currency: 'PLN' } },
      stock: { available: 23 },
      publication: { status: 'ACTIVE' },
      external: { id: 'MUG-350-WHT' },
      isFulfillment: false,
    })
  })

  it('accepts an enum value Allegro adds later', () => {
    const offer = listingOfferSchema.parse(sampleListingOffer({ publication: { status: 'ARCHIVED' } }))
    expect(offer.publication?.status).toBe('ARCHIVED')
  })

  it('parses a product offer with its endedBy', () => {
    expect(productOfferSchema.parse(productOffers.endedSoldOut)).toEqual({
      id: '7834566004',
      publication: { status: 'ENDED', endedBy: 'EMPTY_STOCK' },
      stock: { available: 0 },
    })
    expect(productOfferSchema.parse(sampleProductOffer({ publication: null, stock: null })).publication).toBeNull()
  })
})

describe('checkout form schemas', () => {
  it('parses every sample form', () => {
    for (const form of Object.values(forms)) expect(checkoutFormSchema.safeParse(form).success).toBe(true)
    const page = checkoutFormsPageSchema.parse({ checkoutForms: Object.values(forms), count: 2, totalCount: 2 })
    expect(page.checkoutForms).toHaveLength(Object.keys(forms).length)
  })

  it('strips the PESEL and the message to the seller', () => {
    const raw = sampleCheckoutForm()
    expect(raw).toHaveProperty('messageToSeller')
    expect(raw.buyer).toHaveProperty('personalIdentity')

    const form = checkoutFormSchema.parse(raw)
    expect(form).not.toHaveProperty('messageToSeller')
    expect(form.buyer).not.toHaveProperty('personalIdentity')
    expect(JSON.stringify(form)).not.toContain('90010112345')
    expect(JSON.stringify(form)).not.toContain('gift')
  })

  it('refuses a form without line items or a total', () => {
    const { summary: _summary, ...withoutSummary } = sampleCheckoutForm()
    expect(checkoutFormSchema.safeParse(withoutSummary).success).toBe(false)
    expect(checkoutFormSchema.safeParse({ ...sampleCheckoutForm(), lineItems: undefined }).success).toBe(false)
  })

  it('refuses a date that is not ISO 8601', () => {
    expect(checkoutFormSchema.safeParse(sampleCheckoutForm({ updatedAt: '01.10.2026 09:00' })).success).toBe(false)
  })
})

describe('order event schemas', () => {
  it('parses a page of events', () => {
    const later = sampleOrderEvent({ id: '1791663872701487', type: 'NEW_TYPE' })
    const page = orderEventsPageSchema.parse({ events: [sampleOrderEvent(), later] })
    expect(page.events[0]).toEqual({
      id: '1791663869066571',
      type: 'READY_FOR_PROCESSING',
      occurredAt: '2026-10-01T09:10:05.000Z',
      order: { checkoutForm: { id: '29738e61-c4e8-11f1-89db-60ede9d61a01', revision: '819b5836' } },
    })
    expect(page.events[1]?.type).toBe('NEW_TYPE')
  })

  it('parses the stats of a journal, empty or not', () => {
    expect(orderEventStatsSchema.parse({ latestEvent: { id: '1791663976344997', occurredAt: '2026-10-01T09:10:05.000Z' } }).latestEvent?.id).toBe('1791663976344997')
    expect(orderEventStatsSchema.parse({}).latestEvent).toBeUndefined()
    expect(orderEventStatsSchema.parse({ latestEvent: null }).latestEvent).toBeNull()
  })
})
