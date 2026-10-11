import { AuthExpiredError, PermanentError, RateLimitedError, TransientError, type OfferPrice } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import type { AllegroContext } from '../client'
import { OFFER_EDIT_CONCURRENCY } from './offer-edit'
import { pushPrices } from './price-push'

// Stubbed answers, shaped as the sandbox gave them on 2026-10-10: a 200 echoing the Offer with the amount as sent,
// 422 `IncorrectBaseCurrency` for EUR on an allegro.pl Offer, `PriceBelowMin` under 1.00 PLN, 404 for an unknown id.

function answer(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/vnd.allegro.public.v1+json' } })
}

function offer(id: string, amount: string) {
  return { id, sellingMode: { format: 'BUY_NOW', price: { amount, currency: 'PLN' } }, publication: { status: 'ACTIVE', endedBy: null } }
}

function priceOf(offerExternalId: string, amount = '19.90', currency = 'PLN'): OfferPrice {
  return { offerExternalId, sku: null, price: { amount, currency } }
}

/** `answers` by Offer id; each Offer answers in turn with its own list. */
function push(prices: OfferPrice[], answers: Record<string, Array<() => Response | Promise<Response>>>) {
  const sent: Array<{ method: string; offerId: string; body: unknown }> = []
  let inFlight = 0
  let mostInFlight = 0
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const offerId = new URL(request.url).pathname.split('/').at(-1)!
    sent.push({ method: request.method, offerId, body: await request.json() })
    const next = answers[offerId]?.shift()
    if (!next) throw new Error(`unexpected request for ${offerId}`)
    inFlight++
    mostInFlight = Math.max(mostInFlight, inFlight)
    try {
      await new Promise((resolve) => setTimeout(resolve, 1))
      return await next()
    } finally {
      inFlight--
    }
  }
  const ctx: AllegroContext = {
    app: { clientId: 'client-id', clientSecret: 'client-secret', environment: 'sandbox', appName: 'Hanza Test' },
    config: {},
    credentials: { accessToken: 'access-token', refreshToken: 'refresh-token', accessTokenExpiresAt: '2030-01-01T00:00:00.000Z' },
    fetch,
    log: () => {},
  }
  return { sent, results: pushPrices(ctx, prices), mostInFlight: () => mostInFlight }
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (error: unknown) => error,
  )
}

describe('price.push', () => {
  it('sends the amount and currency exactly as given, one PATCH per Offer', async () => {
    const prices = [priceOf('1', '24'), priceOf('2', '24.0'), priceOf('3', '39.99')]
    const { sent, results } = push(prices, {
      1: [() => answer(200, offer('1', '24'))],
      2: [() => answer(200, offer('2', '24.0'))],
      3: [() => answer(200, offer('3', '39.99'))],
    })
    expect(await results).toEqual(prices.map(({ offerExternalId }) => ({ offerExternalId, outcome: 'ok' })))
    expect(sent).toEqual(
      prices.map(({ offerExternalId, price }) => ({ method: 'PATCH', offerId: offerExternalId, body: { sellingMode: { price } } })),
    )
  })

  it('takes a 202 as accepted, whatever its body shows or whether it can be read', async () => {
    const { results } = push([priceOf('1'), priceOf('2')], {
      1: [() => answer(202, offer('1', '9.99'))],
      2: [() => answer(202, undefined)],
    })
    expect(await results).toEqual([
      { offerExternalId: '1', outcome: 'ok' },
      { offerExternalId: '2', outcome: 'ok' },
    ])
  })

  it("rejects one Offer with Allegro's code, and keeps the others", async () => {
    const { results } = push([priceOf('1', '19.90', 'EUR'), priceOf('2', '0.50'), priceOf('3', '19.999'), priceOf('4'), priceOf('5'), priceOf('6')], {
      1: [() => answer(422, { errors: [{ code: 'IncorrectBaseCurrency', userMessage: 'Currency is incorrect for the specified market.' }] })],
      2: [() => answer(422, { errors: [{ code: 'PriceBelowMin' }] })],
      3: [() => answer(400, { errors: [{ code: 'VALIDATION_ERROR' }] })],
      // No plain code to report: free text never becomes one.
      4: [() => answer(422, { errors: [{ code: 'not a code, Anna Kowalska' }] })],
      5: [() => answer(404, { errors: [{ code: 'OfferNotFoundException' }] })],
      6: [() => answer(200, offer('6', '19.90'))],
    })
    expect(await results).toEqual([
      { offerExternalId: '1', outcome: 'rejected', code: 'IncorrectBaseCurrency' },
      { offerExternalId: '2', outcome: 'rejected', code: 'PriceBelowMin' },
      { offerExternalId: '3', outcome: 'rejected', code: 'VALIDATION_ERROR' },
      { offerExternalId: '4', outcome: 'rejected', code: 'REJECTED' },
      { offerExternalId: '5', outcome: 'rejected', code: 'OFFER_NOT_FOUND' },
      { offerExternalId: '6', outcome: 'ok' },
    ])
  })

  it('rejects one forbidden Offer, but fails the call when every Offer answers 403', async () => {
    const forbidden = () => answer(403, { errors: [{ code: 'ACCESS_DENIED' }] })
    const some = push([priceOf('1'), priceOf('2')], { 1: [forbidden], 2: [() => answer(200, offer('2', '19.90'))] })
    expect(await some.results).toEqual([
      { offerExternalId: '1', outcome: 'rejected', code: 'FORBIDDEN' },
      { offerExternalId: '2', outcome: 'ok' },
    ])
    const every = push([priceOf('1'), priceOf('2')], { 1: [forbidden], 2: [forbidden] })
    const error = await failure(every.results)
    expect(error).toBeInstanceOf(PermanentError)
    expect((error as Error).message).toContain('403')
  })

  it('fails the whole call on a 409, a 401, a 429 or a 5xx', async () => {
    const cases: Array<[Response, new (...args: never[]) => Error]> = [
      [answer(409, { errors: [{ code: 'OPERATION_IN_PROGRESS' }] }), TransientError],
      [answer(401, { error: 'invalid_token' }), AuthExpiredError],
      [answer(429, undefined), RateLimitedError],
      [answer(503, undefined), TransientError],
    ]
    for (const [response, kind] of cases) {
      expect(await failure(push([priceOf('1')], { 1: [() => response] }).results)).toBeInstanceOf(kind)
    }
  })

  it('sends nothing for an empty call, and keeps at most three edits in flight', async () => {
    const empty = push([], {})
    expect(await empty.results).toEqual([])
    expect(empty.sent).toEqual([])

    const ids = Array.from({ length: 8 }, (_, index) => String(index + 1))
    const many = push(
      ids.map((id) => priceOf(id)),
      Object.fromEntries(ids.map((id) => [id, [() => answer(200, offer(id, '19.90'))]])),
    )
    expect((await many.results).every(({ outcome }) => outcome === 'ok')).toBe(true)
    expect(many.mostInFlight()).toBe(OFFER_EDIT_CONCURRENCY)
  })
})
