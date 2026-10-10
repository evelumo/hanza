import { PermanentError, TransientError, type ShipmentLabel } from '@hanza/connector-sdk'
import { failure, readError, send, shipmentPath } from '../client'
import type { InpostContext } from '../config'

const DEFAULT_CONTENT_TYPE = 'application/pdf'

export async function shipmentLabel(ctx: InpostContext, input: { externalId: string }): Promise<ShipmentLabel> {
  const params = new URLSearchParams({ format: 'pdf', type: ctx.config.labelType })
  const response = await send(ctx, `${shipmentPath(input.externalId)}/label?${params}`, {
    headers: { accept: 'application/pdf, application/json' },
  })
  if (!response.ok) {
    // `invalid_action` is "not bought yet". Its HTTP status is not documented, so the key decides on any 4xx.
    if (response.status >= 400 && response.status < 500 && response.status !== 401 && response.status !== 429) {
      const error = await readError(response)
      if (error?.error === 'invalid_action') throw new TransientError('InPost has no label for this Shipment yet')
    }
    throw await failure(response, 'shipment')
  }
  // The content type of a label is not documented either: the header says, and a PDF was asked for.
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || DEFAULT_CONTENT_TYPE
  if (contentType.includes('json')) throw new PermanentError('InPost answered the label request with JSON instead of a file')
  let data: Uint8Array
  try {
    data = new Uint8Array(await response.arrayBuffer())
  } catch (error) {
    throw new TransientError('The label from InPost could not be read', { cause: error })
  }
  if (data.byteLength === 0) throw new TransientError('InPost returned an empty label')
  return { contentType, data }
}
