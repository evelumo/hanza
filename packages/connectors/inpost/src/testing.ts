import { readFile } from 'node:fs/promises'
import { loadCassette, type MatchOptions, type ScrubConfig } from '@hanza/connector-sdk/testing'
import { z } from 'zod'

/**
 * What a recording of ShipX must not keep, on top of the scrubber's defaults (the token, real e-mails). Test
 * tooling: nothing the connector itself imports.
 */
export const inpostScrub: ScrubConfig = {
  keys: {
    // The organization's own data: every string below it, whatever fields ShipX adds.
    sender: 'text',
    // The receiver, field by field, so its e-mail and country code stay readable.
    company_name: 'text',
    first_name: 'text',
    last_name: 'text',
    street: 'text',
    building_number: 'text',
    line1: 'text',
    line2: 'text',
    city: 'text',
    post_code: 'text',
    // ShipX numbers have no `+`, so the scrubber would not know them.
    phone: 'phone',
    comments: 'text',
    // A recording sends a fresh reference every time; as a placeholder the cassette stays the same.
    reference: 'text',
  },
  paths: { 'receiver.name': 'text', 'items.receiver.name': 'text' },
  // The Label prints the receiver's name and address and cannot be scrubbed: the recorder puts a blank PDF in its place.
  replaceBinaryBodies: true,
}

/**
 * How a replay matches. The search for an earlier create starts at a time taken from the request, which a recording
 * sets to "now", so that parameter is not compared. And every recorded answer is served once: a request the
 * recording did not make, above all a second `POST` of the same Shipment, is a miss instead of the last answer again.
 *
 * TODO(#126): the kit is to serve every recorded `POST` and `DELETE` once by itself; `exhausted` then stays only
 * for what it adds here, the `GET`s (a search served twice would hide a create that searched again).
 */
export const inpostMatch: MatchOptions = { ignoreQueryParams: ['created_at_gteq'], exhausted: 'error' }

const recordingCredentialsSchema = z.object({
  apiToken: z.string().min(1),
  organizationId: z.string().regex(/^\d+$/),
  /** A locker that exists on the sandbox, where not every production locker does. */
  targetPoint: z.string().min(1),
})
export type RecordingCredentials = z.output<typeof recordingCredentialsSchema>

/** `packages/connectors/inpost/.recording/credentials.json`, ignored by git. Read only when recording. */
export async function loadRecordingCredentials(): Promise<RecordingCredentials> {
  const file = new URL('../.recording/credentials.json', import.meta.url)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    throw new Error('Recording needs packages/connectors/inpost/.recording/credentials.json with { "apiToken", "organizationId", "targetPoint" } of an InPost sandbox account', { cause: error })
  }
  return recordingCredentialsSchema.parse(JSON.parse(text))
}

const createBodySchema = z.object({
  json: z.object({ reference: z.string().min(1), custom_attributes: z.object({ target_point: z.string().min(1) }) }),
})

/**
 * What the conformance cassette was recorded with. A replay has to send the same: the organization id is in every
 * path, the locker in the request body, and each run's reference became a placeholder that ShipX's answers carry too.
 */
export async function recordedConformance(file: string | URL): Promise<{ organizationId: string; targetPoint: string; reference: string; rejectedReference: string }> {
  const { interactions } = await loadCassette(file)
  const organizationId = /\/organizations\/(\d+)\//.exec(interactions[0]?.request.url ?? '')?.[1]
  const creates = interactions.filter(({ request }) => request.method === 'POST').map(({ request }) => createBodySchema.parse(request.body).json)
  const [accepted, rejected] = creates
  if (organizationId === undefined || accepted === undefined || rejected === undefined) {
    throw new Error('The conformance cassette does not hold an accepted and a rejected create; record it again')
  }
  return { organizationId, targetPoint: accepted.custom_attributes.target_point, reference: accepted.reference, rejectedReference: rejected.reference }
}
