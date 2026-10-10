import { errorFromResponse, isConnectorError, PermanentError, TransientError, type ConnectorError } from '@hanza/connector-sdk'
import type { z } from 'zod'
import { isShipmentId, shipxErrorSchema, shipxShipmentListSchema, type ShipxShipment, type ShipxShipmentList } from './api'
import { INPOST_BASE_URLS, type InpostContext } from './config'
import { isKnownStatus, isStatusKey } from './mapping'

/** The most ShipX serves on a page: asked for 500, it answers with 100 (sandbox, 2026-10-10). */
export const PAGE_SIZE = 100

/** Whose path a request is on, which decides what a 403 or a 404 means. */
export type Scope = 'organization' | 'shipment'

export function organizationShipmentsPath(ctx: InpostContext): string {
  return `/v1/organizations/${encodeURIComponent(ctx.config.organizationId)}/shipments`
}

/**
 * The path of one shipment. Digits only: `..` in its place would turn the label request into `GET /v1/label` and
 * the cancel into `DELETE /v1/`. The id is not put in the message, since whatever it is, it is not an id.
 */
export function shipmentPath(externalId: string): string {
  if (!isShipmentId(externalId)) throw new PermanentError('This Shipment does not carry an InPost shipment id, so InPost cannot be asked about it')
  return `/v1/shipments/${externalId}`
}

const redirected = () =>
  new PermanentError('InPost answered with a redirect, which is not followed: it would send the token and the receiver again, to wherever the redirect points')

// What Node's fetch rejects with under `redirect: 'error'`: a TypeError whose cause says "unexpected redirect". A
// runtime that words it differently gets the transient error below, which sends nothing anywhere either.
function isRefusedRedirect(error: unknown): boolean {
  const cause = (error as { cause?: { message?: unknown } } | null)?.cause
  return error instanceof TypeError && typeof cause?.message === 'string' && /redirect/i.test(cause.message)
}

/**
 * One request with the Connection's token. Resolves with the response whatever its status, except a redirect: a
 * 307 or 308 followed on the create would post the receiver's name, phone, e-mail and address to another host.
 */
export async function send(ctx: InpostContext, path: string, init: RequestInit = {}): Promise<Response> {
  let response: Response
  try {
    response = await ctx.fetch(new URL(path, INPOST_BASE_URLS[ctx.config.environment]), {
      ...init,
      redirect: 'error',
      headers: { accept: 'application/json', ...init.headers, authorization: `Bearer ${ctx.credentials.apiToken}` },
    })
  } catch (error) {
    // The core's rate limiter rejects with a RateLimitedError before sending: that one passes through as it is.
    if (isConnectorError(error)) throw error
    if (isRefusedRedirect(error)) throw redirected()
    throw new TransientError('InPost could not be reached', { cause: error })
  }
  // A transport that hands the redirect over instead of refusing it (a replayed cassette does).
  if ((response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect') {
    await response.body?.cancel().catch(() => {})
    throw redirected()
  }
  return response
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
 * The error a failed response is thrown as. A 401 asks for sign-in. A 403 is what ShipX answers a valid token with
 * the wrong organization id (`forbidden`, "Access forbidden for this token.", sandbox 2026-10-10), and a 404 on an
 * organization's path reads the same: permanent, with a message that says where to look, and never the body.
 */
export async function failure(response: Response, scope: Scope): Promise<ConnectorError> {
  const { status } = response
  const error = await errorFromResponse(response)
  if (error.kind !== 'permanent') return error
  if (status === 403) return new PermanentError(`InPost refused access (403 Forbidden): ${WRONG_ORGANIZATION}`)
  if (status === 404 && scope === 'organization') return new PermanentError(`InPost does not know this organization (404 Not Found): ${WRONG_ORGANIZATION}`)
  return error
}

export interface ShipmentPage extends ShipxShipmentList {
  /** InPost's clock when it answered, from the `Date` header; null when the answer carries none that can be read. */
  serverTime: number | null
}

/** One page of the organization's shipments, each a full shipment resource. */
export async function listShipments(ctx: InpostContext, query: Record<string, string>, page: number): Promise<ShipmentPage> {
  const params = new URLSearchParams({ ...query, page: String(page), per_page: String(PAGE_SIZE) })
  const response = await send(ctx, `${organizationShipmentsPath(ctx)}?${params}`)
  if (!response.ok) throw await failure(response, 'organization')
  const serverTime = Date.parse(response.headers.get('date') ?? '')
  return { ...(await parse(response, shipxShipmentListSchema, 'shipment list')), serverTime: Number.isNaN(serverTime) ? null : serverTime }
}

/**
 * The organization's shipments with these ids, by the `id` filter (a comma list; read straight from ShipX's
 * database, so a shipment shows here the moment it is made, unlike in any other listing). Shipments ShipX does not
 * have, or has for another organization, are simply missing.
 *
 * A filter ShipX ignored shows in `count`: more shipments than ids asked. Pages are read until every id was seen or
 * a page brings nothing new, whatever size ShipX makes them: with this filter its first page came back whole under
 * `per_page: 3`, and the second repeated part of it (sandbox, 2026-10-10).
 */
export async function shipmentsById(ctx: InpostContext, externalIds: string[]): Promise<Map<string, ShipxShipment>> {
  const wanted = new Set(externalIds.filter(isShipmentId))
  const found = new Map<string, ShipxShipment>()
  if (wanted.size === 0) return found
  const query = { id: [...wanted].join(',') }
  const seen = new Set<string>()
  // Each page that does not end the listing brings a shipment not seen before, so there are never more than ids.
  for (let page = 1; page <= wanted.size; page++) {
    const list = await listShipments(ctx, query, page)
    if (list.count > wanted.size) {
      throw new PermanentError(`InPost counts ${list.count} shipments for ${wanted.size} shipment ids, so its id filter cannot be trusted`)
    }
    const before = seen.size
    for (const shipment of list.items) {
      seen.add(shipment.id)
      if (wanted.has(shipment.id)) found.set(shipment.id, shipment)
    }
    if (found.size === wanted.size || seen.size >= list.count || seen.size === before) break
  }
  return found
}

/**
 * Records a status name InPost added since the table was written, so a person learns why a Shipment stopped moving.
 * The name only, and only if it reads as a key: the resource around it holds the receiver's data.
 */
export function logUntranslated(ctx: InpostContext, shipment: ShipxShipment): void {
  if (isKnownStatus(shipment.status)) return
  ctx.log('InPost reports a shipment status this connector does not know', {
    externalId: shipment.id,
    status: isStatusKey(shipment.status) ? shipment.status : 'unreadable',
  })
}
