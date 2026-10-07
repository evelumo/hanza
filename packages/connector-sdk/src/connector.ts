import type { z } from 'zod'
import type { Offer } from './model/offer'
import type { Order, OrderStatus, OrderUpdate } from './model/order'
import type { OfferPrice } from './model/price'
import type { StockLevel } from './model/stock'

export const CONNECTOR_KINDS = ['marketplace', 'shop', 'courier', 'invoicing'] as const
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number]
export const CHANNEL_KINDS: readonly ConnectorKind[] = ['marketplace', 'shop']

export const CONNECTOR_ID_PATTERN = /^[a-z][a-z0-9-]*$/
export const AUTH_TYPES = ['apiKey', 'oauth2', 'none'] as const

export interface CapabilityContext<TConfig = unknown, TCredentials = unknown> {
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
export interface Capabilities<TConfig, TCredentials> {
  /** Every Offer on the Channel, paged; the engine always starts from null. */
  'offers.pull'?(ctx: CapabilityContext<TConfig, TCredentials>, cursor: string | null): Promise<PullResult<Offer>>
  /**
   * Incremental feed of Orders (new ones and ones with new Channel facts). Same cursor → same page.
   * Ready-to-fulfil Orders only, unless the connector also reports unpaid ones with `awaitingPayment: true`
   * and a `paid` fact once they are paid.
   *
   * Cursor `null` (a new Connection, or a restart after `CursorExpiredError`) starts with the Orders open on the
   * Channel now (not shipped or finished, not cancelled; unpaid ones only if the connector reports them), then
   * follows the Channel's journal from a position taken *before* that listing began, so nothing placed meanwhile is
   * lost (an Order seen twice is harmless: the import is idempotent). Orders closed before the Connection never
   * arrive: their Stock was counted on the shelf already. The cursor is opaque, so a journal connector encodes its
   * phase in it, e.g. `l1:<journal position>:<listing offset>` while listing, then `e1:<journal position>`.
   *
   * Items are full Orders, or Order updates (`kind: 'update'`) when the Channel cannot serve the whole Order: the
   * address it reveals only at payment, or a `cancelled` fact for an Order that disappeared (merged into another).
   * Send an update without knowing whether Hanza has the Order; the core ignores updates for Orders it does not have.
   *
   * Throw `CursorExpiredError` when the Channel no longer has the cursor's position (e.g. older than its retention):
   * the core resets the feed to `null` and records the restart. Never restart silently on your own.
   */
  'orders.pull'?(ctx: CapabilityContext<TConfig, TCredentials>, cursor: string | null): Promise<PullResult<Order | OrderUpdate>>
  /** Set absolute availability for up to 100 Offers of this Connection. Must be repeatable. */
  'stock.push'?(ctx: CapabilityContext<TConfig, TCredentials>, levels: StockLevel[]): Promise<void>
  /**
   * Optional. Set the price of up to 100 Offers of this Connection. Each price is in the currency the
   * Channel reported for that Offer in `offers.pull` (Hanza never converts). Must be repeatable.
   */
  'price.push'?(ctx: CapabilityContext<TConfig, TCredentials>, prices: OfferPrice[]): Promise<void>
  /** Translate an Order phase (`status`) to the Channel's own status and set it. Resolve without a call if the Channel has no equivalent. Must be repeatable. */
  'orders.updateStatus'?(
    ctx: CapabilityContext<TConfig, TCredentials>,
    input: { orderExternalId: string; status: OrderStatus },
  ): Promise<void>
}
export type CapabilityName = keyof Capabilities<unknown, unknown>

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
> {
  /** Lowercase slug, /^[a-z][a-z0-9-]*$/. */
  id: string
  name: string
  kind: ConnectorKind
  auth: { type: 'apiKey' } | { type: 'oauth2' } | { type: 'none' }
  /** z.object of string/number/boolean/enum fields; the panel renders a form from it. */
  configSchema: TConfigSchema
  /** Same shape rules; stored encrypted. Use z.object({}) when there are none. */
  credentialsSchema: TCredentialsSchema
  capabilities: Capabilities<z.output<TConfigSchema>, z.output<TCredentialsSchema>>
  /** Optional request limits the core enforces on `ctx.fetch`; none when omitted. */
  rateLimits?: RateLimits
}
export type AnyConnectorDefinition = ConnectorDefinition<z.ZodType, z.ZodType>

/** Capabilities every Channel (marketplace or shop) must implement. */
export const CHANNEL_CAPABILITIES = ['offers.pull', 'orders.pull', 'stock.push'] as const satisfies readonly CapabilityName[]

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

export function defineConnector<TConfig extends z.ZodType, TCredentials extends z.ZodType>(
  definition: ConnectorDefinition<TConfig, TCredentials>,
): ConnectorDefinition<TConfig, TCredentials> {
  if (!CONNECTOR_ID_PATTERN.test(definition.id)) {
    throw new Error(`Invalid connector id "${definition.id}": use lowercase letters, digits and dashes`)
  }
  const problem = rateLimitsProblem(definition.rateLimits)
  if (problem !== null) throw new Error(`Connector "${definition.id}": ${problem}`)
  if (isChannel(definition as unknown as AnyConnectorDefinition)) {
    const implemented = listCapabilities(definition as unknown as AnyConnectorDefinition)
    const missing = CHANNEL_CAPABILITIES.filter((name) => !implemented.includes(name))
    if (missing.length > 0) {
      throw new Error(`Connector "${definition.id}" is a ${definition.kind} and must implement ${missing.join(', ')}`)
    }
  }
  return definition
}
