import type { z } from 'zod'
import type { ConnectorAuth } from './auth'
import type { Offer } from './model/offer'
import type { Order, OrderStatus } from './model/order'
import type { OfferPrice } from './model/price'
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
  /** Global fetch with a 30 s timeout added by the core. */
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
   */
  'orders.pull'?(ctx: CapabilityContext<TConfig, TCredentials, TApp>, cursor: string | null): Promise<PullResult<Order>>
  /** Set absolute availability for up to 100 Offers of this Connection. Must be repeatable. */
  'stock.push'?(ctx: CapabilityContext<TConfig, TCredentials, TApp>, levels: StockLevel[]): Promise<void>
  /**
   * Optional. Set the price of up to 100 Offers of this Connection. Each price is in the currency the
   * Channel reported for that Offer in `offers.pull` (Hanza never converts). Must be repeatable.
   */
  'price.push'?(ctx: CapabilityContext<TConfig, TCredentials, TApp>, prices: OfferPrice[]): Promise<void>
  /** Translate an Order phase (`status`) to the Channel's own status and set it. Resolve without a call if the Channel has no equivalent. Must be repeatable. */
  'orders.updateStatus'?(
    ctx: CapabilityContext<TConfig, TCredentials, TApp>,
    input: { orderExternalId: string; status: OrderStatus },
  ): Promise<void>
}
export type CapabilityName = keyof Capabilities<unknown, unknown, unknown>

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
}
export type AnyConnectorDefinition = ConnectorDefinition<z.ZodType, z.ZodType, z.ZodType>

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
  const { auth } = definition
  if (auth.type === 'oauth2' && auth.deviceFlow && auth.deviceFlow.verificationHosts.length === 0) {
    throw new Error(`Connector "${definition.id}" has a device flow but no verificationHosts`)
  }
  if (isChannel(definition as unknown as AnyConnectorDefinition)) {
    const implemented = listCapabilities(definition as unknown as AnyConnectorDefinition)
    const missing = CHANNEL_CAPABILITIES.filter((name) => !implemented.includes(name))
    if (missing.length > 0) {
      throw new Error(`Connector "${definition.id}" is a ${definition.kind} and must implement ${missing.join(', ')}`)
    }
  }
  return definition
}
