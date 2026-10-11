import { listCapabilities } from '@hanza/connector-sdk'
import { runConformance } from '@hanza/connector-sdk/testing'
import { describe, expect, it } from 'vitest'
import { createMedusaConnector, medusaConnector } from './index'
import { loadRecording, replayConfig, replayCredentials, unauthorizedCredentials } from './testing/recording'
import { medusaScrub } from './testing/scrub'

// The two conformance cassettes are PROVISIONAL: generated from the in-memory store of `src/testing/fake-medusa.ts`
// (`src/testing/conformance-store.ts`) until they are recorded from the sandbox (AGENTS.md, "Tests and cassettes"):
//
//   MEDUSA_RECORDING_SOURCE=fake HANZA_RECORD_FIXTURES=1 pnpm --filter @hanza/connector-medusa exec vitest run src/connector.test.ts
//
// From the sandbox (a fresh one: `sandbox.sh reset`, then wait 10 s for the journal's 5 s hold-back), the same command
// without MEDUSA_RECORDING_SOURCE. The kit pushes stock of 0 and 5 on the first three Offers and ships the first Order.
//
// `journal: true` with an `expiredCursor`: the plugin's journal is pruned, and a position below what it keeps answers
// 410 `journal_expired` (check C18). No `forbidden: false`: a 403 is a missing right, not a sign-out.
describe('the Medusa connector against the conformance kit', () => {
  it('passes the kit on its cassettes', () =>
    runConformance(medusaConnector, {
      fixtures: new URL('./fixtures', import.meta.url),
      config: replayConfig,
      credentials: replayCredentials,
      unauthorized: { credentials: unauthorizedCredentials },
      journal: true,
      expiredCursor: 'e1:1::',
      scrub: medusaScrub,
      recording: () => loadRecording(),
    }), 180_000)
})

describe('the Medusa connector', () => {
  it('is a shop that signs in with an API key and implements the Orders-in, Stock-out capabilities', () => {
    expect(medusaConnector).toMatchObject({ id: 'medusa', name: 'Medusa', kind: 'shop', auth: { type: 'apiKey' } })
    expect(listCapabilities(medusaConnector).sort()).toEqual(['offers.pull', 'orders.pull', 'orders.updateStatus', 'stock.push'])
    // Medusa keeps a sold-out variant published: there is no ended Offer to reopen.
    expect(medusaConnector.reopensSoldOutOffers).toBeUndefined()
  })

  it('limits requests in flight and declares no request rate', () => {
    expect(medusaConnector.rateLimits).toEqual({ connection: { concurrency: 4 } })
  })

  it.each([{ pageSize: 0 }, { pageSize: 101 }, { pageSize: 2.5 }, { journalPageSize: 0 }, { journalPageSize: 501 }])('refuses the options %j', (options) => {
    expect(() => createMedusaConnector(options)).toThrow(/Medusa connector/)
  })

  it.each([{}, { pageSize: 1 }, { pageSize: 100, journalPageSize: 500 }])('accepts the options %j', (options) => {
    expect(createMedusaConnector(options).id).toBe('medusa')
  })
})
