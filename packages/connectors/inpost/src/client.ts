import { errorFromResponse, isConnectorError, PermanentError, TransientError, type ConnectorError } from '@hanza/connector-sdk'
import type { z } from 'zod'
import { shipxErrorSchema, shipxShipmentListSchema, type ShipxShipment, type ShipxShipmentList } from './api'
import { INPOST_BASE_URLS, type InpostContext } from './config'
import { isKey, isKnownStatus } from './mapping'

/** The most ShipX's examples ask for; the real maximum is not documented, so paging trusts the answer's `per_page`. */
export const PAGE_SIZE = 100

/** Whose path a request is on, which decides what a 403 or a 404 means. */
export type Scope = 'organization' | 'shipment'

export function organizationShipmentsPath(ctx: InpostContext): string {
  return `/v1/organizations/${encodeURIComponent(ctx.config.organizationId)}/shipments`
}

export function shipmentPath(externalId: string): string {
  return `/v1/shipments/${encodeURIComponent(externalId)}`
}

/** One request with the Connection's token. Resolves with the response whatever its status; the caller reads it. */
export async function send(ctx: InpostContext, path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await ctx.fetch(new URL(path, INPOST_BASE_URLS[ctx.config.environment]), {
      ...init,
      headers: { accept: 'application/json', ...init.headers, authorization: `Bearer ${ctx.credentials.apiToken}` },
    })
  } catch (error) {
    // The core's rate limiter rejects with a RateLimitedError before sending: that one passes through as it is.
    if (isConnectorError(error)) throw error
    throw new TransientError('InPost could not be reached', { cause: error })
  }
}

export async function parse<T extends z.ZodType>(response: Response, schema: T, what: string): Promise<z.output<T>> {
  const parsed = schema.safeParse(await response.json().catch(() => undefined))
  // Paths only: a zod message could echo the receiver's data back.
  if (!parsed.success) {
    throw new PermanentError(`Unexpected ${what} response from InPost: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`, { cause: parsed.error })
  }
  return parsed.data
}

/** The ShipX error of a failed response (`{ error, details }`), or null when its body is something else. */
export async function readError(response: Response): Promise<z.output<typeof shipxErrorSchema> | null> {
  const parsed = shipxErrorSchema.safeParse(await response.json().catch(() => undefined))
  return parsed.success ? parsed.data : null
}

const WRONG_ORGANIZATION =
  'check that the Organization ID in the Connection settings is the one shown in the API tab of the InPost manager, for the same environment as the token'

/**
 * The error a failed response is thrown as. A 401 asks for sign-in. A 403, or a 404 on an organization's path, is
 * what ShipX answers a valid token with the wrong organization id: permanent, with a message that says where to
 * look, and never the body.
 */
export async function failure(response: Response, scope: Scope): Promise<ConnectorError> {
  const { status } = response
  const error = await errorFromResponse(response)
  if (error.kind !== 'permanent') return error
  if (status === 403) return new PermanentError(`InPost refused access (403 Forbidden): ${WRONG_ORGANIZATION}`)
  if (status === 404 && scope === 'organization') return new PermanentError(`InPost does not know this organization (404 Not Found): ${WRONG_ORGANIZATION}`)
  return error
}

/** One page of the organization's shipments, each a full shipment resource. */
export async function listShipments(ctx: InpostContext, query: Record<string, string>, page: number): Promise<ShipxShipmentList> {
  const params = new URLSearchParams({ ...query, page: String(page), per_page: String(PAGE_SIZE) })
  const response = await send(ctx, `${organizationShipmentsPath(ctx)}?${params}`)
  if (!response.ok) throw await failure(response, 'organization')
  return parse(response, shipxShipmentListSchema, 'shipment list')
}

export function isLastPage(list: ShipxShipmentList): boolean {
  return list.items.length === 0 || list.page * list.per_page >= list.count
}

const MAX_TRACK_PAGES = 10

/**
 * The organization's shipments with these ids, in one request (more only if ShipX pages below what was asked).
 * Shipments it no longer has are simply missing. Stops as soon as every id was seen, and at a page limit: an `id`
 * filter ShipX ignored would otherwise walk the organization's whole history.
 */
export async function shipmentsById(ctx: InpostContext, externalIds: string[]): Promise<Map<string, ShipxShipment>> {
  const wanted = new Set(externalIds)
  const found = new Map<string, ShipxShipment>()
  for (let page = 1; page <= MAX_TRACK_PAGES; page++) {
    const list = await listShipments(ctx, { id: externalIds.join(',') }, page)
    for (const shipment of list.items) if (wanted.has(shipment.id)) found.set(shipment.id, shipment)
    if (found.size === wanted.size || isLastPage(list)) return found
  }
  throw new PermanentError(`InPost listed more than ${MAX_TRACK_PAGES} pages for ${wanted.size} shipment ids, so its id filter cannot be trusted`)
}

/**
 * Records a status name InPost added since the table was written, so a person learns why a Shipment stopped moving.
 * The name only, and only if it reads as a key: the resource around it holds the receiver's data.
 */
export function logUntranslated(ctx: InpostContext, shipment: ShipxShipment): void {
  if (isKnownStatus(shipment.status)) return
  ctx.log('InPost reports a shipment status this connector does not know', {
    externalId: shipment.id,
    status: isKey(shipment.status) ? shipment.status : 'unreadable',
  })
}
