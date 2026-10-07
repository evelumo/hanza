import type { Money } from '@hanza/connector-sdk'
import type { PriceStatus, PushRejection } from '@hanza/core'
import type { Translator } from '@/i18n/types'
import { rejectionText } from './offer-push-status'

/** Whether the status means a price exists but cannot reach the Channel, which a person can fix. */
export const isPriceBlocked = (status: PriceStatus) => status === 'currency_mismatch' || status === 'currency_unknown' || status === 'rejected'

/** One sentence on whether the Offer's price reaches its Channel, and if not, why. */
export function priceStatusText(
  t: Translator,
  offer: {
    priceStatus: PriceStatus
    effectivePrice: Money | null
    channelPrice: Money | null
    lastPricePushedAt: Date | null
    priceRejection?: PushRejection | null
  },
  dateTime: (date: Date) => string,
): string {
  switch (offer.priceStatus) {
    case 'currency_mismatch':
      return t('prices.status.currency_mismatch', {
        channelCurrency: offer.channelPrice?.currency ?? '',
        priceCurrency: offer.effectivePrice?.currency ?? '',
      })
    case 'rejected':
      return offer.priceRejection ? rejectionText(t, offer.priceRejection) : t('prices.status.pending')
    case 'pushed':
      return offer.lastPricePushedAt ? t('prices.status.pushed', { date: dateTime(offer.lastPricePushedAt) }) : t('prices.status.pending')
    default:
      return t(`prices.status.${offer.priceStatus}`)
  }
}
