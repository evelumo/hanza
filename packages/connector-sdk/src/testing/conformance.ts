import { z } from 'zod'
import {
  AUTH_TYPES,
  CHANNEL_CAPABILITIES,
  CONNECTOR_ID_PATTERN,
  CONNECTOR_KINDS,
  isChannel,
  type AnyConnectorDefinition,
  type CapabilityContext,
  type PullResult,
} from '../connector'
import { classifyConnectorError, isConnectorError } from '../errors'
import { offerSchema, type Offer } from '../model/offer'
import { ORDER_STATUSES, orderSchema, type Order } from '../model/order'
import { stockLevelSchema, type StockLevel } from '../model/stock'

export interface ConformanceFixtures {
  config: unknown
  credentials: unknown
  /** Serves recorded responses. Default: a fetch that rejects with "network disabled in conformance tests". */
  fetch?: typeof fetch
  /** If given, orders.pull with these overrides must fail with kind 'auth_expired'. */
  unauthorized?: { credentials?: unknown; fetch?: typeof fetch }
  /** Page limit per pull loop. Default 100. */
  maxPages?: number
}

const pullResultSchema = z.object({
  items: z.array(z.unknown()),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
})

const SCALAR_TYPES = ['string', 'number', 'integer', 'boolean']

interface Page<T> {
  cursorIn: string | null
  items: T[]
  nextCursor: string | null
}

function describeError(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name : typeof error
  return `${name}: ${error instanceof Error ? error.message : String(error)}`
}

/** Null when the schema is a flat object of scalars and string enums, else why not. */
function formShapeProblem(schema: z.ZodType): string | null {
  let json: { type?: unknown; properties?: unknown }
  try {
    json = z.toJSONSchema(schema) as typeof json
  } catch (error) {
    return `cannot be converted to JSON Schema (${describeError(error)})`
  }
  if (json.type !== 'object' || typeof json.properties !== 'object' || json.properties === null) {
    return 'is not a z.object'
  }
  for (const [key, property] of Object.entries(json.properties as Record<string, Record<string, unknown>>)) {
    const { type, enum: values } = property
    const isEnum = type === 'string' && Array.isArray(values) && values.every((value) => typeof value === 'string')
    const isScalar = typeof type === 'string' && SCALAR_TYPES.includes(type) && values === undefined
    if (!isEnum && !isScalar) return `field "${key}" must be a string, number, integer, boolean or string enum`
  }
  return null
}

export async function assertConformance(connector: AnyConnectorDefinition, fixtures: ConformanceFixtures): Promise<void> {
  const failures: string[] = []
  const nonConnectorErrors: string[] = []
  const maxPages = fixtures.maxPages ?? 100
  const fail = (id: string, text: string) => failures.push(`[${id}] ${text}`)
  const check = async (id: string, run: () => void | Promise<void>) => {
    try {
      await run()
    } catch (error) {
      fail(id, `unexpected failure: ${describeError(error)}`)
    }
  }

  // Wraps every capability call so C12 can see what it rejected with.
  const call = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (error) {
      if (!isConnectorError(error)) nonConnectorErrors.push(`${name} rejected with ${describeError(error)}`)
      throw error
    }
  }

  // C1
  if (!CONNECTOR_ID_PATTERN.test(connector.id)) fail('C1', `id "${connector.id}" is not a lowercase slug`)
  if (typeof connector.name !== 'string' || connector.name.trim() === '') fail('C1', 'name is empty')
  if (!CONNECTOR_KINDS.includes(connector.kind)) fail('C1', `kind "${String(connector.kind)}" is not valid`)
  if (!AUTH_TYPES.includes(connector.auth?.type)) fail('C1', `auth.type "${String(connector.auth?.type)}" is not valid`)

  // C2
  const config = connector.configSchema.safeParse(fixtures.config)
  if (!config.success) fail('C2', 'configSchema rejects the config fixture')
  const credentials = connector.credentialsSchema.safeParse(fixtures.credentials)
  if (!credentials.success) fail('C2', 'credentialsSchema rejects the credentials fixture')
  for (const [label, schema] of [
    ['configSchema', connector.configSchema],
    ['credentialsSchema', connector.credentialsSchema],
  ] as const) {
    const problem = formShapeProblem(schema)
    if (problem !== null) fail('C2', `${label} ${problem}`)
  }

  // C3
  if (CONNECTOR_KINDS.includes(connector.kind) && isChannel(connector)) {
    for (const name of CHANNEL_CAPABILITIES) {
      if (typeof connector.capabilities[name] !== 'function') fail('C3', `a ${connector.kind} must implement ${name}`)
    }
  }

  if (!config.success || !credentials.success) {
    return finish(failures, nonConnectorErrors, false)
  }

  const context: CapabilityContext = {
    config: config.data,
    credentials: credentials.data,
    fetch:
      fixtures.fetch ??
      (async () => {
        throw new Error('network disabled in conformance tests')
      }),
    log: () => {},
  }
  const { capabilities } = connector

  // Runs a pull capability from null until hasMore is false, applying the cursor rules shared by C4 and C6.
  const pullAll = async <T>(
    id: string,
    name: string,
    pull: (cursor: string | null) => Promise<PullResult<T>>,
    report: boolean,
  ): Promise<Page<T>[]> => {
    const pages: Page<T>[] = []
    let cursor: string | null = null
    for (let page = 1; ; page++) {
      if (page > maxPages) {
        if (report) fail(id, `${name} still has more after ${maxPages} pages`)
        break
      }
      const parsed = pullResultSchema.safeParse(await call(name, () => pull(cursor)))
      if (!parsed.success) {
        if (report) fail(id, `${name} returned something that is not a PullResult (page ${page})`)
        break
      }
      const result = parsed.data as PullResult<T>
      pages.push({ cursorIn: cursor, items: result.items, nextCursor: result.nextCursor })
      if (!result.hasMore) break
      if (result.nextCursor === null || result.nextCursor === cursor) {
        if (report) fail(id, `${name} has hasMore: true but nextCursor is ${result.nextCursor === null ? 'null' : 'unchanged'} (page ${page})`)
        break
      }
      cursor = result.nextCursor
    }
    return pages
  }

  // C4, C5
  let offers: Offer[] = []
  const pullOffers = capabilities['offers.pull']
  if (pullOffers) {
    await check('C4', async () => {
      const pages = await pullAll('C4', 'offers.pull', (cursor) => pullOffers(context, cursor), true)
      offers = pages.flatMap((page) => page.items as Offer[])
      if (offers.length === 0) fail('C4', 'offers.pull returned no Offers; the fixtures must contain at least one')
      const seen = new Set<string>()
      offers.forEach((offer, index) => {
        const parsedOffer = offerSchema.safeParse(offer)
        if (!parsedOffer.success) {
          fail('C4', `Offer #${index} fails offerSchema: ${z.prettifyError(parsedOffer.error)}`)
          return
        }
        if (seen.has(offer.externalId)) fail('C4', `Offer externalId "${offer.externalId}" is returned twice`)
        seen.add(offer.externalId)
      })
    })
    await check('C5', async () => {
      const again = await pullAll('C5', 'offers.pull', (cursor) => pullOffers(context, cursor), false)
      const ids = (items: Offer[]) => items.map((offer) => offer?.externalId)
      const second = ids(again.flatMap((page) => page.items as Offer[]))
      if (JSON.stringify(ids(offers)) !== JSON.stringify(second)) {
        fail('C5', 'a second offers.pull run returned different Offers or a different order')
      }
    })
  }

  // C6, C7, C8
  let orders: Order[] = []
  const pullOrders = capabilities['orders.pull']
  if (pullOrders) {
    await check('C6', async () => {
      const pages = await pullAll('C6', 'orders.pull', (cursor) => pullOrders(context, cursor), true)
      orders = pages.flatMap((page) => page.items as Order[])
      if (orders.length === 0) fail('C6', 'orders.pull returned no Orders; the fixtures must contain at least one')
      orders.forEach((order, index) => {
        const parsedOrder = orderSchema.safeParse(order)
        if (!parsedOrder.success) {
          fail('C6', `Order #${index} fails orderSchema: ${z.prettifyError(parsedOrder.error)}`)
          return
        }
        const label = `Order "${order.externalId}"`
        if (new Set(order.lines.map((line) => line.externalId)).size !== order.lines.length) {
          fail('C6', `${label} has duplicate line externalIds`)
        }
        if (new Set(order.facts.map((fact) => fact.id)).size !== order.facts.length) {
          fail('C6', `${label} has duplicate fact ids`)
        }
        if (order.lines.some((line) => line.unitPrice.currency !== order.total.currency)) {
          fail('C6', `${label} has a line currency different from its total currency`)
        }
      })

      // Hanza reads awaitingPayment only on the first import: only a paid fact (or a cancellation) ends the wait (ADR 0011).
      const waiting = new Set<string>()
      for (const order of orders) {
        if (!orderSchema.safeParse(order).success) continue
        if (order.awaitingPayment === true) {
          waiting.add(order.externalId)
        } else if (waiting.delete(order.externalId) && !order.facts.some((fact) => fact.type === 'paid' || fact.type === 'cancelled')) {
          fail('C6', `Order "${order.externalId}" was awaiting payment and is returned again without awaitingPayment but with no paid fact`)
        }
      }

      const ids = (items: Order[]) => JSON.stringify(items.map((item) => item?.externalId))
      await check('C7', async () => {
        for (const page of pages) {
          const replay = await call('orders.pull', () => pullOrders(context, page.cursorIn))
          if (ids(replay.items) !== ids(page.items as Order[])) {
            fail('C7', `orders.pull with cursor ${JSON.stringify(page.cursorIn)} returned different Orders the second time`)
          }
        }
      })
      await check('C8', async () => {
        const finalCursor = pages.at(-1)?.nextCursor ?? null
        const tail = await call('orders.pull', () => pullOrders(context, finalCursor))
        if (tail.items.length !== 0 || tail.hasMore) {
          fail('C8', `orders.pull with the final cursor ${JSON.stringify(finalCursor)} must return no items and hasMore: false`)
        }
      })
    })
  }

  // C9
  const pushStock = capabilities['stock.push']
  if (pushStock) {
    await check('C9', async () => {
      await call('stock.push', () => pushStock(context, []))
      const sample = offers.slice(0, 3)
      for (const available of [0, 5]) {
        const levels: StockLevel[] = sample.map((offer) =>
          stockLevelSchema.parse({ offerExternalId: offer.externalId, sku: offer.sku, available }),
        )
        await call('stock.push', () => pushStock(context, levels))
        await call('stock.push', () => pushStock(context, levels))
      }
    })
  }

  // C10
  const updateStatus = capabilities['orders.updateStatus']
  const firstOrder = orders[0]
  if (updateStatus && firstOrder) {
    await check('C10', async () => {
      for (const status of ORDER_STATUSES) {
        for (let attempt = 0; attempt < 2; attempt++) {
          await call('orders.updateStatus', () => updateStatus(context, { orderExternalId: firstOrder.externalId, status }))
        }
      }
    })
  }

  // C11
  if (fixtures.unauthorized) {
    await check('C11', async () => {
      const overrides = fixtures.unauthorized!
      const unauthorizedCredentials = overrides.credentials === undefined
        ? { success: true as const, data: context.credentials }
        : connector.credentialsSchema.safeParse(overrides.credentials)
      if (!unauthorizedCredentials.success) {
        fail('C11', 'credentialsSchema rejects the unauthorized credentials fixture')
        return
      }
      if (!pullOrders) {
        fail('C11', 'orders.pull is missing, so the unauthorized fixture cannot be exercised')
        return
      }
      const unauthorizedContext: CapabilityContext = {
        ...context,
        credentials: unauthorizedCredentials.data,
        fetch: overrides.fetch ?? context.fetch,
      }
      try {
        await pullOrders(unauthorizedContext, null)
      } catch (error) {
        const { kind } = classifyConnectorError(error)
        if (kind !== 'auth_expired') fail('C11', `orders.pull with bad credentials failed as '${kind}', expected 'auth_expired'`)
        return
      }
      fail('C11', 'orders.pull with the unauthorized fixture resolved; it must reject')
    })
  }

  finish(failures, nonConnectorErrors, true)
}

function finish(failures: string[], nonConnectorErrors: string[], ranCapabilities: boolean): void {
  // C12 is only meaningful once capabilities ran.
  if (ranCapabilities) {
    for (const text of nonConnectorErrors) failures.push(`[C12] ${text}; capabilities must reject with a ConnectorError`)
  }
  if (failures.length > 0) {
    throw new Error(`Connector conformance failed:\n${failures.join('\n')}`)
  }
}
