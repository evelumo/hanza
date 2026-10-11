import { listCapabilities } from '@hanza/connector-sdk'
import { runConformance } from '@hanza/connector-sdk/testing'
import { describe, expect, it } from 'vitest'
import { createWooCommerceConnector, woocommerceConnector } from './index'
import { loadRecording, replayConfig, replayCredentials, unauthorizedCredentials } from './testing/recording'
import { woocommerceScrub } from './testing/scrub'

// To record the two conformance cassettes again, from a fresh shop (`sandbox.sh reset`) that has been up for at least
// 30 s: the Order feed reads only entries older than its 20 s hold-back on the shop's clock, and check C7 reads each
// page twice. The kit pushes stock of 0 and 5 and moves the first Order through every phase, so use a shop you can
// lose, and record this file before the other recordings or on a shop of its own (sandbox/README.md):
//
//   WOO_SANDBOX_PROJECT=<name> WOO_SANDBOX_PORT=<port> HANZA_RECORD_FIXTURES=1 \
//     pnpm --filter @hanza/connector-woocommerce exec vitest run src/connector.test.ts
//
// No `journal` and no `expiredCursor`: the Order feed is built on snapshots, which the shop keeps for ever, so no
// cursor of it expires and check C18 does not apply. No `forbidden: false`: a 403 here is a missing right, not a sign-out.
describe('the WooCommerce connector against the conformance kit', () => {
  it('passes the kit on its recorded cassettes', () =>
    runConformance(woocommerceConnector, {
      fixtures: new URL('./fixtures', import.meta.url),
      config: replayConfig,
      credentials: replayCredentials,
      unauthorized: { credentials: unauthorizedCredentials },
      scrub: woocommerceScrub,
      recording: () => loadRecording(),
    }), 180_000)
})

describe('the WooCommerce connector', () => {
  it('is a shop that signs in with an API key and implements the Orders-in, Stock-out capabilities', () => {
    expect(woocommerceConnector).toMatchObject({ id: 'woocommerce', name: 'WooCommerce', kind: 'shop', auth: { type: 'apiKey' } })
    expect(listCapabilities(woocommerceConnector).sort()).toEqual(['offers.pull', 'orders.pull', 'orders.updateStatus', 'stock.push'])
    // WooCommerce keeps a product published at stock 0, so there is no sold-out Offer to reopen.
    expect(woocommerceConnector.reopensSoldOutOffers).toBeUndefined()
  })

  it('limits requests in flight and declares no request rate', () => {
    expect(woocommerceConnector.rateLimits).toEqual({ connection: { concurrency: 2 } })
  })

  it.each([{ pageSize: 0 }, { pageSize: 101 }, { pageSize: 2.5 }, { holdBackSeconds: -1 }, { holdBackSeconds: 0.5 }])('refuses the options %j', (options) => {
    expect(() => createWooCommerceConnector(options)).toThrow(/WooCommerce connector/)
  })

  it.each([{}, { pageSize: 1 }, { pageSize: 100 }, { pageSize: 5, holdBackSeconds: 0 }])('accepts the options %j', (options) => {
    expect(createWooCommerceConnector(options).id).toBe('woocommerce')
  })
})
