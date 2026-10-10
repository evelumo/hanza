import type { ShipmentRequest } from '@hanza/connector-sdk'
import { isRecording, loadCassette, runConformance, Scrubber } from '@hanza/connector-sdk/testing'
import { describe, expect, it } from 'vitest'
import { inpostConnector } from './index'
import { inpostMatch, inpostScrub, loadRecordingCredentials, recordedConformance } from './testing'

const fixtures = new URL('./fixtures/', import.meta.url)
const conformanceCassette = new URL('conformance.cassette.json', fixtures)

// Stand-ins: the recorder never wrote the real token, and a replay scrubs these the same way before matching.
const replayCredentials = { apiToken: 'replay-token-00000000' }
const unknownCredentials = { apiToken: 'a-token-inpost-does-not-know' }

// A fictitious receiver; the number is the one InPost's own documentation uses for its examples.
const receiver = { name: 'Jan Kowalski', company: null, email: 'jan.kowalski@example.com', phone: '111222333' }

describe('InPost connector', () => {
  it(
    'passes the conformance kit on its cassettes',
    async () => {
      // Recording: the sandbox account of `.recording/`, a reference of this run and "now". Replaying: what the
      // cassette was recorded with, because its paths, its locker and its (scrubbed) references have to match.
      const sandbox = isRecording() ? await loadRecordingCredentials() : null
      const fresh = `hanza-conformance-${Date.now()}`
      const run = sandbox
        ? { organizationId: sandbox.organizationId, targetPoint: sandbox.targetPoint, reference: fresh, rejectedReference: `${fresh}-rejected`, requestedAt: new Date().toISOString() }
        : { ...(await recordedConformance(conformanceCassette)), requestedAt: '2026-10-10T09:00:00Z' }

      const request: ShipmentRequest = {
        reference: run.reference,
        requestedAt: run.requestedAt,
        service: 'inpost_locker_standard',
        receiver,
        destination: { type: 'pickup_point', pointId: run.targetPoint },
        parcel: { preset: 'small' },
        cashOnDelivery: null,
      }

      await runConformance(inpostConnector, {
        fixtures,
        config: { environment: 'sandbox', organizationId: run.organizationId },
        credentials: replayCredentials,
        unauthorized: { credentials: unknownCredentials },
        scrub: inpostScrub,
        match: inpostMatch,
        shipment: {
          request,
          // A locker code no InPost locker has.
          rejected: { request: { ...request, reference: run.rejectedReference, destination: { type: 'pickup_point', pointId: 'XXX000X' } } },
          // InPost buys the label a few seconds after the create; a replay never waits.
          labelWaitMs: 3_000,
        },
        recording: () => ({ credentials: { apiToken: sandbox!.apiToken } }),
      })
    },
    isRecording() ? 120_000 : 10_000,
  )
})

describe('the conformance cassette', { skip: isRecording() }, () => {
  it('shows one create per reference: the repeated create of the kit posted nothing', async () => {
    const { interactions } = await loadCassette(conformanceCassette)
    const posted = interactions.filter(({ request }) => request.method === 'POST').map(({ request }) => (request.body as { json: { reference: string } }).json.reference)
    expect(posted).toHaveLength(2)
    expect(new Set(posted).size).toBe(2)
  })

  it('holds the placeholder of the recorder where the Label was, never a real one', async () => {
    const { interactions } = await loadCassette(conformanceCassette)
    const labels = interactions.filter(({ request, response }) => request.url.includes('/label') && response.status === 200)
    expect(labels).toHaveLength(1)
    const placeholder = new Scrubber({ replaceBinaryBodies: true }).body({ base64: 'AA==' }, 'application/pdf')
    expect(labels[0]!.response.body).toEqual(placeholder)
  })
})
