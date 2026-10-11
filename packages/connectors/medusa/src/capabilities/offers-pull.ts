import { PermanentError, TransientError, type Offer, type PullResult } from '@hanza/connector-sdk'
import { VARIANT_FIELDS, variantsPageSchema, type MedusaVariant } from '../api'
import { request } from '../client'
import { mapOffer } from '../mapping/offer'
import { offerCurrency, readStatus } from '../plugin'
import type { MedusaContext } from '../settings'

export interface OffersPullOptions {
  /** Variants per page. */
  pageSize: number
}

/**
 * Position in the variant list: the currency read from the plugin at the start (null for none), how many variants were
 * read up to the last one returned (`consumed`, an offset under `order=id`), and that variant's id.
 */
interface OffersCursor {
  currency: string | null
  consumed: number
  lastId: string
}

const PREFIX = 'v1'
const WHOLE = /^(0|[1-9]\d{0,14})$/
/** Requests one call may spend stepping back over variants deleted since the last page, before it gives up. */
export const MAX_STEP_BACKS = 3

export function encodeOffersCursor(cursor: OffersCursor): string {
  return [PREFIX, cursor.currency ?? '-', String(cursor.consumed), encodeURIComponent(cursor.lastId)].join(':')
}

export function decodeOffersCursor(text: string): OffersCursor {
  const parts = text.split(':')
  const unreadable = () => new PermanentError('Unreadable Medusa Offers cursor')
  if (parts.length !== 4 || parts[0] !== PREFIX) throw unreadable()
  const [, currency, consumed, lastId] = parts as [string, string, string, string]
  if (!(currency === '-' || /^[A-Z]{3}$/.test(currency)) || !WHOLE.test(consumed) || lastId === '') throw unreadable()
  let id: string
  try {
    id = decodeURIComponent(lastId)
  } catch {
    throw unreadable()
  }
  return { currency: currency === '-' ? null : currency, consumed: Number(consumed), lastId: id }
}

async function page(ctx: MedusaContext, offset: number, limit: number): Promise<MedusaVariant[]> {
  const { variants } = await request(ctx, {
    path: 'product-variants',
    query: [
      ['order', 'id'],
      ['offset', offset],
      ['limit', limit],
      ['fields', VARIANT_FIELDS],
    ],
    schema: variantsPageSchema,
    what: 'variant list',
  })
  return variants
}

/**
 * Every variant as an Offer, by offset under `order=id`. A plain offset would skip a variant whenever one before it is
 * deleted between two pages, so each page after the first starts one page early (it overlaps the previous page by
 * `pageSize` variants) and only variants after the last one returned are kept. If the overlap does not reach back to
 * that variant (more than a page of variants deleted meanwhile), the call steps back another page, up to
 * `MAX_STEP_BACKS` times. Relies on Medusa's `order=id` sorting ids the way JavaScript compares them (AGENTS.md).
 */
export async function pullOffers(ctx: MedusaContext, cursorText: string | null, options: OffersPullOptions): Promise<PullResult<Offer>> {
  const { pageSize } = options
  let currency: string | null
  let after: { consumed: number; lastId: string } | null = null
  if (cursorText === null) {
    // Once per pull: the plugin says which currency Offer prices are reported in.
    currency = offerCurrency(await readStatus(ctx))
  } else {
    const cursor = decodeOffersCursor(cursorText)
    currency = cursor.currency
    after = cursor
  }

  // Every request reads up to one page past the last variant returned; after the first, it starts a page early.
  const end = after === null ? pageSize : after.consumed + pageSize
  let offset = after === null ? 0 : Math.max(0, after.consumed - pageSize)
  let variants = await page(ctx, offset, end - offset)
  for (let backs = 0; after !== null && offset > 0 && !(variants[0] !== undefined && variants[0].id <= after.lastId); backs++) {
    if (backs >= MAX_STEP_BACKS) {
      throw new TransientError('The Medusa variant list moved by more than a few pages while it was read; the next pull starts again')
    }
    offset = Math.max(0, offset - pageSize)
    variants = await page(ctx, offset, end - offset)
  }
  const limit = end - offset
  const fresh = after === null ? variants : variants.filter((variant) => variant.id > after.lastId)
  const items = fresh.map((variant) => mapOffer(variant, currency))
  const last = fresh.at(-1)
  const hasMore = variants.length >= limit && last !== undefined
  if (last === undefined) {
    // Nothing after the last variant: the list is done. The cursor stays where it was.
    return { items: [], nextCursor: cursorText, hasMore: false }
  }
  return { items, nextCursor: encodeOffersCursor({ currency, consumed: offset + variants.length, lastId: last.id }), hasMore }
}
