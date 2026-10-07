import { OFFER_ENDED_CODE, type OfferPublication, type PushRejection, type StockPushStatus } from '@hanza/core'
import type { Translator } from '@/i18n/types'

/** "Active", "Ended (sold out)", or "Unknown" when the Channel never said. */
export function publicationLabel(t: Translator, publication: OfferPublication | null): string {
  if (publication === null) return t('labels.publication.unknown')
  if (publication.status === 'ended' && publication.endedReason === 'sold_out') return t('labels.publication.ended_sold_out')
  return t(`labels.publication.${publication.status}`)
}

/** Why a push was not applied. The Channel's own code is shown as it is: Hanza does not know every Channel's codes. */
export function rejectionText(t: Translator, rejection: PushRejection): string {
  return rejection.code === OFFER_ENDED_CODE ? t('offerPush.offerEnded') : t('offerPush.rejected', { code: rejection.code })
}

/** One sentence on whether the Offer's stock reaches its Channel. */
export function stockStatusText(
  t: Translator,
  offer: { stockStatus: StockPushStatus; stockRejection: PushRejection | null; lastPushedAvailable: number | null; lastPushedAt: Date | null },
  dateTime: (date: Date) => string,
): string {
  switch (offer.stockStatus) {
    case 'rejected':
      return offer.stockRejection ? rejectionText(t, offer.stockRejection) : t('offerPush.stock.pending')
    case 'pushed':
      return offer.lastPushedAt
        ? t('offerPush.stock.pushed', { count: offer.lastPushedAvailable ?? 0, date: dateTime(offer.lastPushedAt) })
        : t('offerPush.stock.pending')
    default:
      return t(`offerPush.stock.${offer.stockStatus}`)
  }
}
