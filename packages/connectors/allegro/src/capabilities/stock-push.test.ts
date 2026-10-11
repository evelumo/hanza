import { describe, expect, it } from 'vitest'
import type { AllegroContext } from '../client'
import { pushStock } from './stock-push'

// The answers the sandbox gave on 2026-10-10, one stubbed `PATCH` at a time: Allegro changes an Offer's publication
// after it answers, so an answer never shows the ending or the reopening it causes.

const OFFER_ID = '7834566001'

function offer(status: string, endedBy: string | null = null, available = 0) {
  return { id: OFFER_ID, publication: { status, endedBy }, stock: { available, unit: 'UNIT' } }
}

function answer(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/vnd.allegro.public.v1+json' } })
}

function push(available: number, ...answers: Response[]) {
  const sent: unknown[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    sent.push(await request.json())
    const next = answers.shift()
    if (!next) throw new Error('unexpected request')
    return next
  }
  const ctx: AllegroContext = {
    app: { clientId: 'client-id', clientSecret: 'client-secret', environment: 'sandbox', appName: 'Hanza Test' },
    config: {},
    credentials: { accessToken: 'access-token', refreshToken: 'refresh-token', accessTokenExpiresAt: '2030-01-01T00:00:00.000Z' },
    fetch,
    log: () => {},
  }
  return { sent, results: pushStock(ctx, [{ offerExternalId: OFFER_ID, sku: 'MUG-350-WHT', available }]) }
}

describe('stock.push', () => {
  it('reports a 0 as ended although the answer still shows the Offer active', async () => {
    const { results } = push(0, answer(200, offer('ACTIVE')))
    expect(await results).toEqual([{ offerExternalId: OFFER_ID, outcome: 'ended' }])
  })

  it('reports a 0 to an Offer already ended as ended, and to a draft as set', async () => {
    expect(await push(0, answer(200, offer('ENDED', 'EMPTY_STOCK'))).results).toEqual([{ offerExternalId: OFFER_ID, outcome: 'ended' }])
    expect(await push(0, answer(200, offer('INACTIVE'))).results).toEqual([{ offerExternalId: OFFER_ID, outcome: 'ok' }])
  })

  it('takes a 202 it cannot read as accepted: ended for a 0, set for a number above it', async () => {
    expect(await push(0, answer(202, undefined)).results).toEqual([{ offerExternalId: OFFER_ID, outcome: 'ended' }])
    expect(await push(4, answer(202, undefined)).results).toEqual([{ offerExternalId: OFFER_ID, outcome: 'ok' }])
  })

  it('reopens a sold-out Offer once: a 202 that still shows it ended is done', async () => {
    const { sent, results } = push(3, answer(200, offer('ENDED', 'EMPTY_STOCK', 3)), answer(202, offer('ENDED', 'EMPTY_STOCK', 3)))
    expect(await results).toEqual([{ offerExternalId: OFFER_ID, outcome: 'ok' }])
    expect(sent).toEqual([{ stock: { available: 3 } }, { publication: { status: 'ACTIVE' } }])
  })

  it('leaves an Offer the seller ended alone, and keeps a 409 on the reopen for the next push', async () => {
    const byUser = push(3, answer(200, offer('ENDED', 'USER', 3)))
    expect(await byUser.results).toEqual([{ offerExternalId: OFFER_ID, outcome: 'rejected', code: 'OFFER_ENDED_USER' }])
    expect(byUser.sent).toHaveLength(1)
    const pending = push(3, answer(200, offer('ENDED', 'EMPTY_STOCK', 3)), answer(409, { errors: [{ code: 'OPERATION_IN_PROGRESS' }] }))
    expect(await pending.results).toEqual([{ offerExternalId: OFFER_ID, outcome: 'rejected', code: 'OFFER_REOPEN_PENDING' }])
  })
})
