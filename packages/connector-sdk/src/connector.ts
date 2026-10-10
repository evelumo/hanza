import type { z } from 'zod'
import type { ConnectorAuth } from './auth'
import type { Offer } from './model/offer'
import type { Order, OrderPhase, OrderUpdate } from './model/order'
import type { OfferPrice } from './model/price'
import type { PricePushResult, StockPushResult } from './model/push-result'
import {
  shippingServiceSchema,
  type ShipmentCancelResult,
  type ShipmentCreateResult,
  type ShipmentLabel,
  type ShipmentRequest,
  type ShipmentState,
  type ShippingService,
} from './model/shipment'
import type { StockLevel } from './model/stock'

export const CONNECTOR_KINDS = ['marketplace', 'shop', 'courier', 'invoicing'] as const
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number]
export const CHANNEL_KINDS: readonly ConnectorKind[] = ['marketplace', 'shop']

export const CONNECTOR_ID_PATTERN = /^[a-z][a-z0-9-]*$/
export const AUTH_TYPES = ['apiKey', 'oauth2', 'none'] as const

export interface CapabilityContext<TConfig = unknown, TCredentials = unknown, TApp = unknown> {
  /** Installation settings, parsed with `appConfigSchema`; `{}` when the connector declares none. Never log them. */
  app: TApp
  /** Non-secret settings, parsed with `configSchema`. */
  config: TConfig
  /** Secrets, parsed with `credentialsSchema`. The connector adds them to its own requests; never log them. */
  credentials: TCredentials
  /**
   * Global fetch with a 30 s timeout added by the core, which also enforces the connector's `rateLimits`: it may
   * wait briefly, or reject with a `RateLimitedError` before sending. Let a `ConnectorError` from it through
   * unchanged (wrap only other rejections, e.g. as `TransientError`).
   */
  fetch: typeof fetch
  log(message: string, fields?: Record<string, unknown>): void
}

export interface PullResult<T> {
  items: T[]
  /** Position to resume from next time; null only when nothing was ever returned. */
  nextCursor: string | null
  /** True when more are available right now; the engine then calls again with `nextCursor`. */
  hasMore: boolean
}

// Method syntax on purpose: it keeps definitions with specific config types assignable to AnyConnectorDefinition.
export interface Capabilities<TConfig, TCredentials, TApp = unknown> {
  /** Every Offer on the Channel, paged; the engine always starts from null. */
  'offers.pull'?(ctx: CapabilityContext<TConfig, TCredentials, TApp>, cursor: string | null): Promise<PullResult<Offer>>
  /**
   * Incremental feed of Orders (new ones and ones with new Channel facts). Same cursor → same page.
   * Ready-to-fulfil Orders only, unless the connector also reports unpaid ones with `awaitingPayment: true`
   * and a `paid` fact once they are paid.
   *
   * Cursor `null` (a new Connection, or a restart after `CursorExpiredError`) starts the feed (ADR 0021):
   * - First take the feed's start: the journal position now, and the boundary that tells Orders placed before it
   *   from Orders placed after it (a time or an id). Both stay in every cursor of the feed, for ever. Take the journal
   *   position FIRST and the boundary SECOND (Allegro: `GET /order/event-stats`, then `boughtBefore` = now): the
   *   other way round, an Order placed between the two moments is neither listed (placed after the boundary) nor sent
   *   in full (its events come before the journal position), so it never reserves.
   * - Then list the Orders open on the Channel now (not shipped or finished, not cancelled; unpaid ones only if the
   *   connector reports them) and placed before the boundary. Page the listing so that an Order closing between two
   *   pages cannot make another one skipped: a keyset (the last key listed, in an order that never changes, such as
   *   purchase time then id) under the frozen boundary, or, where the API only pages by offset, overlapping pages
   *   (step back and accept duplicates). Never a plain offset.
   * - Then follow the journal from the start's position, so nothing placed meanwhile is lost. In the journal a full
   *   Order is sent **only for an Order placed after the boundary**; a change to any other Order goes as an Order
   *   update. So an Order closed before the Connection is never imported (its Stock was counted on the shelf already):
   *   its later journal entries reach the core as updates, which it ignores.
   * The cursor is opaque, so a journal connector encodes all of this in it, e.g.
   * `l1:<journal position>:<boundary>:<last listed key>` while listing, then `e1:<journal position>:<boundary>`.
   * An Order returned twice is harmless: the import is idempotent.
   *
   * Items are full Orders, or Order updates (`kind: 'update'`) when the Channel cannot serve the whole Order, or the
   * Order was placed before the feed's boundary: the address it reveals only at payment, or a `cancelled` fact for an
   * Order that disappeared (merged into another). A full Order carries every fact the Channel has for it at that
   * moment, and comes before any update of the same Order on a page. Send an update without knowing whether Hanza
   * has the Order; the core ignores updates for Orders it does not have.
   *
   * Throw `CursorExpiredError` when the Channel no longer has the cursor's position (e.g. older than its retention):
   * the core resets the feed to `null` and records the restart. Never restart silently on your own.
   */
  'orders.pull'?(ctx: CapabilityContext<TConfig, TCredentials, TApp>, cursor: string | null): Promise<PullResult<Order | OrderUpdate>>
  /**
   * Set absolute availability for up to 100 Offers of this Connection, 0 included. Must be repeatable.
   * May return a result per Offer: `rejected` (with a short Channel error code) when the Channel refused one Offer,
   * so the others still count as pushed; `ended` when the Channel ended the Offer because it got 0. Offers left out
   * of the results, or no results at all (nothing, or null), count as `ok`. Throw for a failure of the whole call.
   */
  'stock.push'?(ctx: CapabilityContext<TConfig, TCredentials, TApp>, levels: StockLevel[]): Promise<void | StockPushResult[]>
  /**
   * Optional. Set the price of up to 100 Offers of this Connection. Each price is in the currency the
   * Channel reported for that Offer in `offers.pull` (Hanza never converts). Must be repeatable.
   * May return per-Offer results like `stock.push` (`ok` or `rejected`).
   */
  'price.push'?(ctx: CapabilityContext<TConfig, TCredentials, TApp>, prices: OfferPrice[]): Promise<void | PricePushResult[]>
  /** Translate an Order phase (`phase`) to the Channel's own status and set it. Resolve without a call if the Channel has no equivalent. Must be repeatable. */
  'orders.updateStatus'?(
    ctx: CapabilityContext<TConfig, TCredentials, TApp>,
    input: { orderExternalId: string; phase: OrderPhase },
  ): Promise<void>
  /**
   * Ask the Carrier for one Shipment. **Must be repeatable: a second call with the same `reference` returns the
   * Shipment the first one made, never another one**, also when the first call's answer was lost (the job died after
   * the Carrier answered). A Carrier without an idempotency key needs a lookup before the request: search the
   * Shipments made since `requestedAt` (the same on every repeat) for the `reference`, and ask for a new one only
   * when none has it.
   *
   * The request names one of the connector's `shipping.services` and fits it (destination type, parcel preset or
   * dimensions, cash on delivery only where the service takes it): the core refuses anything else before the call.
   * What the Carrier needs beyond that is the connector's to check, such as a phone, or a currency it collects.
   *
   * Returns `created` with the Shipment's state (`pending` or `ready` for a new one; a repeat returns the Shipment
   * as it is now), or `rejected` with a short code when the Carrier refuses this request for good (an unknown pickup
   * point, a missing phone): the Shipment then fails and is never asked for again. Throw only for a failure of the
   * call (auth, rate limit, network), which the core retries. The receiver and the address are Buyer data: never log
   * them, and never put them in an error message or a code.
   */
  'shipments.create'?(ctx: CapabilityContext<TConfig, TCredentials, TApp>, request: ShipmentRequest): Promise<ShipmentCreateResult>
  /**
   * The current state of up to 100 Shipments of this Connection, by the ids `shipments.create` returned. Must be
   * repeatable. A Shipment left out of the answer is unchanged, so leave out one whose Carrier status the connector
   * cannot translate instead of guessing; never answer for an id that was not asked. An empty list resolves to an
   * empty list without a request. Report `failed` (with the reason as `carrierStatus`) when the Carrier will never
   * confirm a Shipment. Throw for a failure of the whole call.
   */
  'shipments.track'?(ctx: CapabilityContext<TConfig, TCredentials, TApp>, externalIds: string[]): Promise<ShipmentState[]>
  /**
   * The Label of one Shipment. The core asks once the Shipment is `ready` or later and stores the file, so this is
   * not called for every download. Throw `TransientError` while the Carrier has none yet; the core asks again.
   */
  'shipments.label'?(ctx: CapabilityContext<TConfig, TCredentials, TApp>, input: { externalId: string }): Promise<ShipmentLabel>
  /**
   * Optional. Ask the Carrier to cancel a Shipment it has not taken. Returns `cancelled`, also for a Shipment that
   * is already cancelled or gone, or `refused` with a short code when it is too late. Must be repeatable. Throw for a
   * failure of the call.
   */
  'shipments.cancel'?(ctx: CapabilityContext<TConfig, TCredentials, TApp>, input: { externalId: string }): Promise<ShipmentCancelResult>
}
export type CapabilityName = keyof Capabilities<unknown, unknown, unknown>

/** At most `requests` requests in any window of `windowMs` milliseconds. */
export interface RequestRate {
  requests: number
  windowMs: number
}

/**
 * Limits the core enforces on `ctx.fetch` across every worker of the installation, so Hanza slows itself
 * down before the Channel blocks it. Set them below the Channel's published limits, leaving headroom.
 */
export interface RateLimits {
  /** Shared by every Connection of this connector on the installation, across organizations (one API application). */
  application?: RequestRate
  /** Per Connection (one account on the Channel): a request rate and/or how many requests may be in flight at once. */
  connection?: { rate?: RequestRate; concurrency?: number }
}

export interface ConnectorDefinition<
  TConfigSchema extends z.ZodType = z.ZodType,
  TCredentialsSchema extends z.ZodType = z.ZodType,
  TAppSchema extends z.ZodType = z.ZodType,
> {
  /** Lowercase slug, /^[a-z][a-z0-9-]*$/. */
  id: string
  name: string
  kind: ConnectorKind
  /** How the Connection signs in. `oauth2` may add token refresh and a device-flow sign-in, both driven by the core. */
  auth: ConnectorAuth<z.output<TConfigSchema>, z.output<TCredentialsSchema>, z.output<TAppSchema>>
  /**
   * Installation settings, the same for every Connection on this Hanza (e.g. an OAuth application's client id
   * and secret). Same shape rules as `configSchema`. The core reads field `clientId` of connector `my-shop` from
   * `HANZA_CONNECTOR_MY_SHOP_CLIENT_ID`; while a required one is missing the connector cannot be connected.
   */
  appConfigSchema?: TAppSchema
  /** z.object of string/number/boolean/enum fields; the panel renders a form from it. */
  configSchema: TConfigSchema
  /** Same shape rules; stored encrypted. Use z.object({}) when there are none. */
  credentialsSchema: TCredentialsSchema
  capabilities: Capabilities<z.output<TConfigSchema>, z.output<TCredentialsSchema>, z.output<TAppSchema>>
  /**
   * True when `stock.push` with a number above 0 reactivates an Offer that ended because it sold out
   * (`endedReason: 'sold_out'`). Without it Hanza never pushes to an ended Offer and reports it rejected (ADR 0022).
   * Hanza decides from the publication it last pulled, which may be stale: a connector that declares this must check,
   * at push time, why the Offer ended, reopen it only if it sold out, and report `rejected` otherwise.
   */
  reopensSoldOutOffers?: boolean
  /** Optional request limits the core enforces on `ctx.fetch`; none when omitted. */
  rateLimits?: RateLimits
  /**
   * What a connector with `shipments.create` offers: the services a person chooses from when making a Shipment.
   * Static, like `rateLimits`: the same for every Connection, never fetched from the Carrier.
   */
  shipping?: { services: ShippingService[] }
}
export type AnyConnectorDefinition = ConnectorDefinition<z.ZodType, z.ZodType, z.ZodType>

/** Capabilities every Channel (marketplace or shop) must implement. */
export const CHANNEL_CAPABILITIES = ['offers.pull', 'orders.pull', 'stock.push'] as const satisfies readonly CapabilityName[]

/**
 * Capabilities a connector that makes Shipments must implement together (`shipments.cancel` is optional). About
 * capabilities, not `kind`: a Channel with its own shipping may implement them too.
 */
export const SHIPMENT_CAPABILITIES = ['shipments.create', 'shipments.track', 'shipments.label'] as const satisfies readonly CapabilityName[]

export function listCapabilities(connector: AnyConnectorDefinition): CapabilityName[] {
  return (Object.keys(connector.capabilities) as CapabilityName[]).filter(
    (name) => connector.capabilities[name] !== undefined,
  )
}

export function isChannel(connector: AnyConnectorDefinition): boolean {
  return CHANNEL_KINDS.includes(connector.kind)
}

const isPositiveInteger = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/** Null when `rateLimits` is absent or valid, else what is wrong with it. */
export function rateLimitsProblem(rateLimits: RateLimits | undefined): string | null {
  if (rateLimits === undefined) return null
  const rateProblem = (label: string, rate: RequestRate | undefined) =>
    rate === undefined || (isPositiveInteger(rate.requests) && isPositiveInteger(rate.windowMs))
      ? null
      : `${label} needs positive integer requests and windowMs`
  const { application, connection } = rateLimits
  return (
    rateProblem('rateLimits.application', application) ??
    rateProblem('rateLimits.connection.rate', connection?.rate) ??
    (connection?.concurrency === undefined || isPositiveInteger(connection.concurrency)
      ? null
      : 'rateLimits.connection.concurrency must be a positive integer')
  )
}

/** True when Shipments can be made through this connector: it implements `shipments.create`, whatever its kind. */
export function canShip(connector: AnyConnectorDefinition): boolean {
  return connector.capabilities['shipments.create'] !== undefined
}

/** The service a connector declares under this id, if any. */
export function findShippingService(connector: AnyConnectorDefinition, serviceId: string): ShippingService | undefined {
  return connector.shipping?.services.find((service) => service.id === serviceId)
}

/** Null when the shipment capabilities and `shipping.services` of a connector fit together, else what is wrong. */
export function shippingProblem(connector: Pick<AnyConnectorDefinition, 'capabilities' | 'shipping'>): string | null {
  const declared: unknown = connector.shipping?.services
  const services = Array.isArray(declared) ? (declared as ShippingService[]) : []
  const implemented = (name: CapabilityName) => connector.capabilities[name] !== undefined
  if (!implemented('shipments.create')) {
    return services.length > 0 ? 'shipping.services are declared but shipments.create is missing' : null
  }
  const missing = SHIPMENT_CAPABILITIES.filter((name) => !implemented(name))
  if (missing.length > 0) return `shipments.create needs ${missing.join(' and ')} as well`
  if (services.length === 0) return 'shipments.create needs at least one service in shipping.services'
  const ids = new Set<string>()
  for (const [index, service] of services.entries()) {
    const id: unknown = service?.id
    if (typeof id !== 'string' || id === '') return `shipping service #${index + 1} has an empty id`
    if (ids.has(id)) return `shipping service "${id}" is declared twice`
    ids.add(id)
    if (service.parcel?.type === 'presets') {
      const presets = Array.isArray(service.parcel.presets) ? service.parcel.presets : []
      if (presets.length === 0) return `shipping service "${id}" has no parcel presets`
      const presetIds = presets.map((preset) => preset?.id)
      const repeated = presetIds.find((presetId, position) => presetIds.indexOf(presetId) !== position)
      if (repeated !== undefined) return `shipping service "${id}" declares the parcel preset "${String(repeated)}" twice`
    }
    const issue = shippingServiceSchema.safeParse(service).error?.issues[0]
    if (issue) return `shipping service "${id}" is not well formed (${issue.path.join('.')}: ${issue.message})`
  }
  return null
}

/** The device flow of a connector, if it has one. */
export function deviceFlowOf(connector: AnyConnectorDefinition) {
  return connector.auth.type === 'oauth2' ? connector.auth.deviceFlow : undefined
}

export function defineConnector<
  TConfig extends z.ZodType,
  TCredentials extends z.ZodType,
  TApp extends z.ZodType = z.ZodObject<Record<never, z.ZodType>>,
>(definition: ConnectorDefinition<TConfig, TCredentials, TApp>): ConnectorDefinition<TConfig, TCredentials, TApp> {
  if (!CONNECTOR_ID_PATTERN.test(definition.id)) {
    throw new Error(`Invalid connector id "${definition.id}": use lowercase letters, digits and dashes`)
  }
  const problem = rateLimitsProblem(definition.rateLimits)
  if (problem !== null) throw new Error(`Connector "${definition.id}": ${problem}`)
  const { auth } = definition
  if (auth.type === 'oauth2' && auth.deviceFlow && auth.deviceFlow.verificationHosts.length === 0) {
    throw new Error(`Connector "${definition.id}" has a device flow but no verificationHosts`)
  }
  const shipping = shippingProblem(definition as unknown as AnyConnectorDefinition)
  if (shipping !== null) throw new Error(`Connector "${definition.id}": ${shipping}`)
  if (isChannel(definition as unknown as AnyConnectorDefinition)) {
    const implemented = listCapabilities(definition as unknown as AnyConnectorDefinition)
    const missing = CHANNEL_CAPABILITIES.filter((name) => !implemented.includes(name))
    if (missing.length > 0) {
      throw new Error(`Connector "${definition.id}" is a ${definition.kind} and must implement ${missing.join(', ')}`)
    }
  }
  return definition
}
