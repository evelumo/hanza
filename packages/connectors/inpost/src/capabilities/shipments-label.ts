import { PermanentError, TransientError, type ShipmentLabel } from '@hanza/connector-sdk'
import { failure, readError, send, shipmentPath } from '../client'
import type { InpostContext } from '../config'

/** The core stores a Label of at most 5 MB; a body past that is not read to its end. */
export const MAX_LABEL_BYTES = 5 * 1024 * 1024

const PDF_CONTENT_TYPE = 'application/pdf'
const PDF_MAGIC = new TextEncoder().encode('%PDF-')
const TOO_LARGE = `The label from InPost is larger than ${MAX_LABEL_BYTES / (1024 * 1024)} MB`

/** The body, read no further than the cap; null when it is longer. */
async function readCapped(response: Response): Promise<Uint8Array | null> {
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_LABEL_BYTES) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const data = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.byteLength
  }
  return data
}

export async function shipmentLabel(ctx: InpostContext, input: { externalId: string }): Promise<ShipmentLabel> {
  const params = new URLSearchParams({ format: 'pdf' })
  // Without `type` ShipX returns a normal label, and A6 for courier services, which have no normal one [18153509].
  // What an explicit `type=normal` does for a courier shipment is not documented, so it is never sent.
  if (ctx.config.labelType !== 'normal') params.set('type', ctx.config.labelType)
  const response = await send(ctx, `${shipmentPath(input.externalId)}/label?${params}`, {
    headers: { accept: 'application/pdf, application/json' },
  })
  if (!response.ok) {
    // `invalid_action` is "not bought yet" (HTTP 400 on the sandbox). The key decides, on any 4xx.
    if (response.status >= 400 && response.status < 500 && response.status !== 401 && response.status !== 429) {
      const error = await readError(response)
      if (error?.error === 'invalid_action') throw new TransientError('InPost has no label for this Shipment yet')
    }
    throw await failure(response, 'shipment')
  }
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (declared > MAX_LABEL_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw new PermanentError(TOO_LARGE)
  }
  let data: Uint8Array | null
  try {
    data = await readCapped(response)
  } catch (error) {
    throw new TransientError('The label from InPost could not be read', { cause: error })
  }
  if (data === null) throw new PermanentError(TOO_LARGE)
  if (data.byteLength === 0) throw new TransientError('InPost returned an empty label')
  // The file itself says what it is, not the header: a 200 with an error page of the edge in front of ShipX, or
  // with JSON, would otherwise be stored as this Shipment's Label for good. Such an answer may pass; ask again.
  if (!PDF_MAGIC.every((byte, index) => data[index] === byte)) throw new TransientError('InPost answered the label request with something that is not a PDF')
  return { contentType: PDF_CONTENT_TYPE, data }
}
