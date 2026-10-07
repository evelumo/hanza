import { describe, expect, it } from 'vitest'
import { currentRejection, decideStockPush, describeOfferStock, publicationFromColumns } from './offer-push'

describe('decideStockPush (ADR 0022)', () => {
  const soldOut = { status: 'ended', endedReason: 'sold_out' } as const
  const endedBySeller = { status: 'ended', endedReason: 'other' } as const
  const endedUnknown = { status: 'ended', endedReason: null } as const

  it('pushes to active, inactive and unknown Offers, 0 included', () => {
    for (const publication of [null, { status: 'active', endedReason: null }, { status: 'inactive', endedReason: null }] as const) {
      expect(decideStockPush(0, publication, false)).toBe('push')
      expect(decideStockPush(5, publication, true)).toBe('push')
    }
  })

  it('reopens only a sold-out Offer, and only through a connector that reopens', () => {
    expect(decideStockPush(3, soldOut, true)).toBe('push')
    expect(decideStockPush(3, soldOut, false)).toBe('reject')
    expect(decideStockPush(3, endedBySeller, true)).toBe('reject')
    expect(decideStockPush(3, endedUnknown, true)).toBe('reject')
  })

  it('sends nothing to an ended Offer that is told 0', () => {
    for (const publication of [soldOut, endedBySeller, endedUnknown]) expect(decideStockPush(0, publication, true)).toBe('skip')
  })
})

describe('publication and rejection views', () => {
  it('keeps an ended reason only for ended Offers', () => {
    expect(publicationFromColumns(null, null)).toBeNull()
    expect(publicationFromColumns('ended', 'sold_out')).toEqual({ status: 'ended', endedReason: 'sold_out' })
    expect(publicationFromColumns('active', 'sold_out')).toEqual({ status: 'active', endedReason: null })
  })

  it('shows a rejection only while nothing newer waits', () => {
    const at = new Date('2026-10-06T10:00:00Z')
    expect(currentRejection('X', at, false)).toEqual({ code: 'X', at })
    expect(currentRejection('X', at, true)).toBeNull()
    expect(currentRejection(null, null, false)).toBeNull()
  })

  it('describes the stock push of an Offer', () => {
    const base = {
      productId: 'p',
      channelStatus: null,
      channelEndedReason: null,
      lastPushedAvailable: 4,
      lastPushedAt: new Date('2026-10-06T09:00:00Z'),
      stockPushSeq: 2,
      stockPushedSeq: 2,
      stockRejectedCode: null,
      stockRejectedAt: null,
    }
    const at = new Date('2026-10-06T10:00:00Z')
    expect(describeOfferStock(base).stockStatus).toBe('pushed')
    expect(describeOfferStock({ ...base, productId: null }).stockStatus).toBe('not_linked')
    expect(describeOfferStock({ ...base, stockPushSeq: 3 }).stockStatus).toBe('pending')
    expect(describeOfferStock({ ...base, stockRejectedCode: 'X', stockRejectedAt: at })).toMatchObject({
      stockStatus: 'rejected',
      stockRejection: { code: 'X', at },
    })
    expect(describeOfferStock({ ...base, stockRejectedCode: 'X', stockRejectedAt: at, stockPushSeq: 3 })).toMatchObject({
      stockStatus: 'pending',
      stockRejection: null,
    })
    expect(describeOfferStock({ ...base, lastPushedAt: null, lastPushedAvailable: null }).stockStatus).toBe('not_sent')
  })
})
