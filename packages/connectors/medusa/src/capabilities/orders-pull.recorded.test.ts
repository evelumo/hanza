import { isOrderUpdate, type OrderFeedItem } from '@hanza/connector-sdk'
import { loadCassette, openCassette, type CassetteInteraction } from '@hanza/connector-sdk/testing'
import { describe, expect, it } from 'vitest'
import { createMedusaConnector } from '../connector'
import type { MedusaContext } from '../settings'
import { loadRecording, replayConfig, replayCredentials } from '../testing/recording'
import { medusaScrub } from '../testing/scrub'
import { encodeCursor } from './orders-cursor'

// The journal of the recorded sandbox after the conformance run (sandbox/README.md, "Recording"): the kit shipped
// order 1 (a fulfillment and a shipment), then order 2 was cancelled in Medusa and order 1's payment captured. The
// feed resumes from the position and the boundary the conformance run ended at, both read from its cassette, so the
// two orders, placed before the boundary, come back as Order updates with the facts of what happened.

const FIXTURES = new URL('../fixtures/', import.meta.url)
const CASSETTE = new URL('orders-journal-changes.cassette.json', FIXTURES)

/** Where the conformance run left the feed: its last journal position and the boundary it read. */
async function feedStartOfConformance(): Promise<{ position: number; boundary: { time: string; id: string } }> {
  const cassette = await loadCassette(new URL('conformance.cassette.json', FIXTURES))
  const interactions: CassetteInteraction[] = cassette.interactions
  const positions = interactions.flatMap((interaction) => {
    const url = new URL(interaction.request.url)
    return url.pathname.endsWith('/admin/hanza/journal') && interaction.response.status === 200 ? [Number(url.searchParams.get('after'))] : []
  })
  const boundaryAnswer = interactions.find((interaction) => interaction.request.url.includes('order=-created_at&limit=1'))
  const body = boundaryAnswer?.response.body
  const newest = body && 'json' in body ? (body.json as { orders: Array<{ id: string; created_at: string }> }).orders[0] : undefined
  if (positions.length === 0 || newest === undefined) throw new Error('conformance.cassette.json has no journal position or boundary to resume from')
  return { position: Math.max(...positions), boundary: { time: newest.created_at, id: newest.id } }
}

describe('orders.pull against the recorded store', () => {
  it('reports, from the position the conformance run ended at, the shipment and the capture of order 1 and the cancel of order 2 as Order updates', async () => {
    const start = await feedStartOfConformance()
    const cassette = await openCassette(CASSETTE, { scrub: medusaScrub, secrets: [replayCredentials.apiKey], recording: () => loadRecording() })
    const credentials = cassette.mode === 'record' ? (await loadRecording()).credentials : replayCredentials
    const requests: string[] = []
    const ctx: MedusaContext = {
      app: {},
      config: replayConfig,
      credentials,
      fetch: (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        requests.push(`${init?.method ?? 'GET'} ${url.pathname.replace('/admin/', '')}`)
        return cassette.fetch(input, init)
      },
      log: () => {},
    }
    try {
      const cursor = encodeCursor({ phase: 'journal', position: start.position, boundary: start.boundary })
      const page = await createMedusaConnector().capabilities['orders.pull']!(ctx, cursor)

      const items: OrderFeedItem[] = page.items
      expect(items.every(isOrderUpdate)).toBe(true)
      // Facts come oldest first: order 1 was shipped by the kit before its payment was captured; order 2 was paid at
      // the seed and refunded by Medusa's cancel (`payment_status: refunded` keeps its paid fact, ADR 0003).
      expect(items.map((item) => item.facts.map((fact) => fact.type))).toEqual([
        ['shipped', 'paid'],
        ['paid', 'cancelled'],
      ])
      for (const item of items) {
        expect(item.facts.map((fact) => fact.id)).toEqual(item.facts.map((fact) => `${item.externalId}:${fact.type}`))
        if (!isOrderUpdate(item)) continue
        // The update carries the addresses as Medusa has them now (scrubbed in the cassette), for an Order still in phase new.
        expect(item.shippingAddress?.countryCode).toBe('PL')
      }
      expect(page.hasMore).toBe(false)
      expect(page.nextCursor).toMatch(/^e1:\d+:/)
      expect(page.nextCursor).not.toBe(cursor)
      // The status, the journal page, then one re-read of the orders it names, batched by id.
      expect(requests).toEqual(['GET hanza/status', 'GET hanza/journal', 'GET orders'])
      expect(cassette.misses).toEqual([])
    } finally {
      await cassette.close()
    }
  }, 60_000)
})
