import { OFFER_ENDED_CODE, type PriceStatus, type PushRejection, type StockPushStatus } from '@hanza/core'
import type { Tone } from '@/components/tone'

/**
 * Where a push of an Offer's stock or price stands, as the page states it at a glance. The tone says who has to
 * act: `critical` the Channel refused it (Retry helps once the cause is fixed), `attention` Hanza holds it back
 * until a person changes something, `neutral` nothing is wrong and nothing is sent.
 */
export interface PushState {
  kind: 'sent' | 'waiting' | 'rejected' | 'notSent'
  tone: Tone
}

const sent: PushState = { kind: 'sent', tone: 'success' }
const waiting: PushState = { kind: 'waiting', tone: 'info' }
const idle: PushState = { kind: 'notSent', tone: 'neutral' }
const heldBack: PushState = { kind: 'notSent', tone: 'attention' }
const refused: PushState = { kind: 'rejected', tone: 'critical' }

export function stockPushState(offer: { stockStatus: StockPushStatus; stockRejection: PushRejection | null }): PushState {
  switch (offer.stockStatus) {
    case 'pushed':
      return sent
    case 'pending':
      return waiting
    case 'rejected':
      if (!offer.stockRejection) return waiting
      // Hanza's own `offer_ended` (ADR 0022) changes only when the Channel reports the Offer again, so a Retry would not help.
      return offer.stockRejection.code === OFFER_ENDED_CODE ? heldBack : refused
    default:
      return idle
  }
}

export function pricePushState(offer: { priceStatus: PriceStatus; priceRejection: PushRejection | null }): PushState {
  switch (offer.priceStatus) {
    case 'pushed':
      return sent
    case 'pending':
      return waiting
    case 'rejected':
      return offer.priceRejection ? refused : waiting
    // A price exists but cannot reach the Channel until someone sets one in the Channel's currency (ADR 0011).
    case 'currency_mismatch':
    case 'currency_unknown':
      return heldBack
    default:
      return idle
  }
}
