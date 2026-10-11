import { OFFER_ENDED_CODE } from '@hanza/core'
import { describe, expect, it } from 'vitest'
import { pricePushState, stockPushState } from './push-state'

const at = new Date('2026-01-01T00:00:00Z')

describe('stockPushState', () => {
  it('tells a stock the Channel has from one still waiting', () => {
    expect(stockPushState({ stockStatus: 'pushed', stockRejection: null })).toEqual({ kind: 'sent', tone: 'success' })
    expect(stockPushState({ stockStatus: 'pending', stockRejection: null })).toEqual({ kind: 'waiting', tone: 'info' })
  })

  it('marks a refusal by the Channel as rejected, which a Retry can fix', () => {
    expect(stockPushState({ stockStatus: 'rejected', stockRejection: { code: 'FAKE_REJECTED', at } })).toEqual({ kind: 'rejected', tone: 'critical' })
  })

  it('does not call an ended Offer that Hanza holds back rejected', () => {
    expect(stockPushState({ stockStatus: 'rejected', stockRejection: { code: OFFER_ENDED_CODE, at } })).toEqual({ kind: 'notSent', tone: 'attention' })
  })

  it('asks for a person while the Product has unset Stock', () => {
    expect(stockPushState({ stockStatus: 'unset', stockRejection: null })).toEqual({ kind: 'notSent', tone: 'attention' })
  })

  it('is quiet when nothing is sent and nothing is wrong', () => {
    expect(stockPushState({ stockStatus: 'not_linked', stockRejection: null })).toEqual({ kind: 'notSent', tone: 'neutral' })
    expect(stockPushState({ stockStatus: 'not_sent', stockRejection: null })).toEqual({ kind: 'notSent', tone: 'neutral' })
  })
})

describe('pricePushState', () => {
  it('asks for a person when a price exists but its currency keeps it from the Channel', () => {
    expect(pricePushState({ priceStatus: 'currency_mismatch', priceRejection: null })).toEqual({ kind: 'notSent', tone: 'attention' })
    expect(pricePushState({ priceStatus: 'currency_unknown', priceRejection: null })).toEqual({ kind: 'notSent', tone: 'attention' })
  })

  it('is quiet when there is no price to send', () => {
    for (const priceStatus of ['no_price', 'unsupported', 'not_linked'] as const) {
      expect(pricePushState({ priceStatus, priceRejection: null })).toEqual({ kind: 'notSent', tone: 'neutral' })
    }
  })

  it('marks a refused price as rejected', () => {
    expect(pricePushState({ priceStatus: 'rejected', priceRejection: { code: 'PRICE_TOO_LOW', at } })).toEqual({ kind: 'rejected', tone: 'critical' })
    expect(pricePushState({ priceStatus: 'pushed', priceRejection: null })).toEqual({ kind: 'sent', tone: 'success' })
  })
})
