import type { z } from 'zod'
import type { Order } from './model/order'
import type { StockLevel } from './model/stock'

/** What the core hands to a capability. A connector never sees the database. */
export interface CapabilityContext<TConfig> {
  /** Connection settings, validated against the connector's `configSchema`. */
  config: TConfig
  /** Authenticated HTTP client for the external API (tokens, rate limits). */
  fetch: typeof fetch
  log(message: string, fields?: Record<string, unknown>): void
}

export interface PullResult<T> {
  items: T[]
  /** Opaque position to resume from; stored by the core per connection. */
  nextCursor: string | null
}

export interface Capabilities<TConfig> {
  'orders.pull'?: (ctx: CapabilityContext<TConfig>, cursor: string | null) => Promise<PullResult<Order>>
  'stock.push'?: (ctx: CapabilityContext<TConfig>, levels: StockLevel[]) => Promise<void>
}

export type CapabilityName = keyof Capabilities<unknown>

export interface ConnectorDefinition<TConfigSchema extends z.ZodType = z.ZodType> {
  /** Stable, lowercase identifier, e.g. "allegro". */
  id: string
  name: string
  kind: 'marketplace' | 'shop' | 'courier' | 'invoicing'
  auth: { type: 'oauth2' } | { type: 'apiKey' }
  /** The panel renders the connection form from this schema. */
  configSchema: TConfigSchema
  capabilities: Capabilities<z.infer<TConfigSchema>>
}

const ID_PATTERN = /^[a-z][a-z0-9-]*$/

export function defineConnector<TConfigSchema extends z.ZodType>(
  definition: ConnectorDefinition<TConfigSchema>,
): ConnectorDefinition<TConfigSchema> {
  if (!ID_PATTERN.test(definition.id)) {
    throw new Error(`Invalid connector id "${definition.id}": use lowercase letters, digits and dashes`)
  }
  return definition
}

export function listCapabilities(connector: ConnectorDefinition): CapabilityName[] {
  return (Object.keys(connector.capabilities) as CapabilityName[]).filter(
    (name) => connector.capabilities[name] !== undefined,
  )
}
