import { z } from 'zod'
import {
  AUTH_TYPES,
  CHANNEL_CAPABILITIES,
  CONNECTOR_ID_PATTERN,
  CONNECTOR_KINDS,
  findShippingService,
  isChannel,
  rateLimitsProblem,
  shippingProblem,
  type AnyConnectorDefinition,
  type CapabilityContext,
  type PullResult,
} from '../connector'
import { deviceSignInPollSchema, deviceSignInStartSchema, isAllowedVerificationUri, type AuthContext } from '../auth'
import { classifyConnectorError, isConnectorError, isCursorExpiredError } from '../errors'
import { offerSchema, type Offer } from '../model/offer'
import { ORDER_PHASES, orderSchema, orderUpdateSchema, type Order } from '../model/order'
import { offerPriceSchema, type OfferPrice } from '../model/price'
import { pricePushResultSchema, stockPushResultSchema } from '../model/push-result'
import {
  shipmentCancelResultSchema,
  shipmentCreateResultSchema,
  shipmentLabelSchema,
  shipmentRequestProblem,
  shipmentRequestSchema,
  shipmentStateSchema,
  type ShipmentRequest,
} from '../model/shipment'
import { stockLevelSchema, type StockLevel } from '../model/stock'

export interface ConformanceFixtures {
  /** Installation settings, checked against `appConfigSchema` when the connector has one. Default `{}`. */
  app?: unknown
  config: unknown
  credentials: unknown
  /** Serves recorded responses. Default: a fetch that rejects with "network disabled in conformance tests". */
  fetch?: typeof fetch
  /**
   * If given, orders.pull with these overrides must fail with kind 'auth_expired' (C11). A connector without
   * orders.pull that makes Shipments is asked for `shipments.track` of the Shipment S2 created instead. A connector
   * with `shipments.create` is also asked to create the shipment request fixture again with them: that must fail as
   * 'auth_expired' too, never come back as `rejected`.
   */
  unauthorized?: { credentials?: unknown; fetch?: typeof fetch }
  /**
   * C14: the pulls, run against a Channel that answers every request `403 Forbidden` (no auth signal), must not fail
   * `auth_expired`, and must send a request when `fetch` is given. Default: a fetch answering a bare 403. Pass `false` only if the Channel really uses 403 for
   * rejected credentials, and say so in the connector's AGENTS.md. A connector without orders.pull that makes
   * Shipments is checked on `shipments.track` of the Shipment S2 created. A connector with `shipments.create` is
   * checked on a create of the shipment request fixture as well, which must not come back as `rejected` either: a
   * 403 is a refusal of the account, not of this request.
   */
  forbidden?: false | { fetch?: typeof fetch }
  /** C18: if given, orders.pull with this cursor (one the recorded Channel no longer has) must fail with `CursorExpiredError`. */
  expiredCursor?: string
  /**
   * The connector follows a Channel journal (ADR 0021): C18 then requires `expiredCursor`. Order updates cannot be
   * required here: a run from cursor null starts the journal at the newest position, so a recording has no later
   * changes in it. Cover them with a scenario cassette that pulls from an older journal cursor (see the skill).
   */
  journal?: boolean
  /** Page limit per pull loop. Default 100. */
  maxPages?: number
  /**
   * Required when the connector has `auth.refresh` (C15): `auth.refresh` of `credentials` with this `fetch`
   * must succeed; with `refused`, it must fail with kind 'auth_expired'.
   */
  refresh?: { fetch?: typeof fetch; refused?: { credentials?: unknown; fetch?: typeof fetch } }
  /** Required when the connector has `auth.deviceFlow` (C16): `start`, then one `poll` of its device code, with this `fetch`. */
  deviceFlow?: { fetch?: typeof fetch }
  /** Required when the connector has `shipments.create` (S1 to S8). */
  shipment?: ShipmentFixtures
}

export interface ShipmentFixtures {
  /**
   * A request the Carrier accepts, for one of the connector's declared services (S2). The Shipment it makes is the
   * one S3 to S5 and S7 use, and C11 and C14 for a connector without orders.pull. C11, C14 and S8 send it again
   * against a Carrier that refuses or fails, which makes no Shipment. When recording, give it a `reference` no earlier
   * run used: a repeatable create would hand back that run's Shipment.
   */
  request: ShipmentRequest
  /**
   * Milliseconds S3 waits between the first create and its repeat. Default 0; used only when recording against a real
   * Carrier (a replay never waits). The core never repeats a create at once (`SHIPMENT_CREATE_RETRY_DELAY_MS`), and
   * a Carrier's list may lag behind its own create, so a recording made without a wait shows a second Shipment that
   * the core would never have caused. Set it to what the Carrier's lag needs, at most that delay.
   */
  repeatWaitMs?: number
  /**
   * S4: an id of the Carrier's own form that it does not know, tracked together with the Shipment S2 created. Default
   * `"0"`.
   */
  unknownExternalId?: string
  /** S6: a request the Carrier refuses for good (an unknown pickup point), under another `reference`. */
  rejected?: { request: ShipmentRequest }
  /**
   * S5 asks for the Label again while `shipments.label` fails as 'transient' (the Carrier has none yet), tracking
   * the Shipment in between: at most this many times. Default 10.
   */
  labelAttempts?: number
  /** Milliseconds S5 waits before it asks again. Default 0; a recording against a real Carrier needs a few seconds. */
  labelWaitMs?: number
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

/** An Order update carries `kind: 'update'`; anything else in an orders.pull page is checked as a full Order. */
function isUpdateItem(item: unknown): item is { kind: 'update'; externalId?: unknown; facts?: unknown } {
  return typeof item === 'object' && item !== null && (item as { kind?: unknown }).kind === 'update'
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
  const rateLimits = rateLimitsProblem(connector.rateLimits)
  if (rateLimits !== null) fail('C1', rateLimits)

  // C2
  const config = connector.configSchema.safeParse(fixtures.config)
  if (!config.success) fail('C2', 'configSchema rejects the config fixture')
  const credentials = connector.credentialsSchema.safeParse(fixtures.credentials)
  if (!credentials.success) fail('C2', 'credentialsSchema rejects the credentials fixture')
  const app = connector.appConfigSchema ? connector.appConfigSchema.safeParse(fixtures.app ?? {}) : { success: true as const, data: {} }
  if (!app.success) fail('C2', 'appConfigSchema rejects the app fixture')
  for (const [label, schema] of [
    ['configSchema', connector.configSchema],
    ['credentialsSchema', connector.credentialsSchema],
    ...(connector.appConfigSchema ? [['appConfigSchema', connector.appConfigSchema] as const] : []),
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

  if (!config.success || !credentials.success || !app.success) {
    return finish(failures, nonConnectorErrors, false)
  }

  const context: CapabilityContext = {
    app: app.data,
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

  // C6, C7, C8, C17
  let orders: Order[] = []
  let feed: unknown[] = []
  const pullOrders = capabilities['orders.pull']
  if (pullOrders) {
    await check('C6', async () => {
      const pages = await pullAll('C6', 'orders.pull', (cursor) => pullOrders(context, cursor), true)
      feed = pages.flatMap((page) => page.items as unknown[])
      orders = feed.filter((item) => !isUpdateItem(item)) as Order[]
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

      // Hanza reads awaitingPayment only on the first import: only a paid fact (or a cancellation) ends the wait (ADR 0015).
      const endsWait = (facts: Order['facts']) => facts.some((fact) => fact.type === 'paid' || fact.type === 'cancelled')
      const waiting = new Set<string>()
      for (const item of feed) {
        if (isUpdateItem(item)) {
          const update = orderUpdateSchema.safeParse(item)
          if (update.success && endsWait(update.data.facts)) waiting.delete(update.data.externalId)
          continue
        }
        const order = orderSchema.safeParse(item)
        if (!order.success) continue
        if (order.data.awaitingPayment === true) {
          waiting.add(order.data.externalId)
        } else if (waiting.delete(order.data.externalId) && !endsWait(order.data.facts)) {
          fail('C6', `Order "${order.data.externalId}" was awaiting payment and is returned again without awaitingPayment but with no paid fact`)
        }
      }

      // An update is identified by its Order and its fact ids, so a replay that reports other facts differs.
      const identity = (item: unknown) => {
        if (!isUpdateItem(item)) return (item as { externalId?: unknown } | null)?.externalId
        const facts = Array.isArray(item.facts) ? item.facts.map((fact) => (fact as { id?: unknown } | null)?.id) : null
        return ['update', item.externalId, facts]
      }
      const ids = (items: unknown[]) => JSON.stringify(items.map(identity))
      await check('C7', async () => {
        for (const page of pages) {
          const replay = await call('orders.pull', () => pullOrders(context, page.cursorIn))
          if (ids(replay.items) !== ids(page.items)) {
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

    // Updates for Orders this run never returned in full are fine: the Order may have closed before the Connection,
    // and the core ignores updates for Orders it does not have. What must hold is that fact ids are stable.
    await check('C17', async () => {
      const typeOf = new Map<string, string>()
      const remember = (externalId: string, fact: { id: string; type: string }) => {
        const key = JSON.stringify([externalId, fact.id])
        const known = typeOf.get(key)
        if (known === undefined) typeOf.set(key, fact.type)
        else if (known !== fact.type) {
          fail('C17', `fact "${fact.id}" of Order "${externalId}" is reported as ${known} and as ${fact.type}; a fact id must keep its meaning`)
        }
      }
      feed.forEach((item, index) => {
        if (!isUpdateItem(item)) {
          const order = orderSchema.safeParse(item)
          if (order.success) order.data.facts.forEach((fact) => remember(order.data.externalId, fact))
          return
        }
        const update = orderUpdateSchema.safeParse(item)
        if (!update.success) {
          fail('C17', `Order update #${index} fails orderUpdateSchema: ${z.prettifyError(update.error)}`)
          return
        }
        const { externalId, facts } = update.data
        if (new Set(facts.map((fact) => fact.id)).size !== facts.length) {
          fail('C17', `Order update for "${externalId}" has duplicate fact ids`)
        }
        facts.forEach((fact) => remember(externalId, fact))
      })
    })
  }

  // C18
  if (fixtures.expiredCursor === undefined && fixtures.journal === true) {
    fail('C18', 'a journal connector must give the expiredCursor fixture: a cursor the recorded Channel no longer has')
  }
  if (fixtures.expiredCursor !== undefined) {
    await check('C18', async () => {
      if (!pullOrders) {
        fail('C18', 'orders.pull is missing, so the expired cursor fixture cannot be exercised')
        return
      }
      try {
        await call('orders.pull', () => pullOrders(context, fixtures.expiredCursor!))
      } catch (error) {
        if (!isCursorExpiredError(error)) fail('C18', `orders.pull with the expired cursor failed with ${describeError(error)}, expected CursorExpiredError`)
        return
      }
      fail('C18', 'orders.pull with the expired cursor resolved; it must reject with CursorExpiredError')
    })
  }

  // Per-Offer results are optional; when returned they must name only Offers of the call, once each.
  const checkResults = (
    id: string,
    name: string,
    raw: unknown,
    schema: z.ZodType<{ offerExternalId: string; outcome: string }>,
    sent: Array<{ offerExternalId: string; available?: number }>,
  ) => {
    if (raw === undefined || raw === null) return
    const parsed = z.array(schema).safeParse(raw)
    if (!parsed.success) {
      fail(id, `${name} returned results that are not an array of per-Offer results: ${z.prettifyError(parsed.error)}`)
      return
    }
    const byId = new Map(sent.map((item) => [item.offerExternalId, item]))
    const seen = new Set<string>()
    for (const result of parsed.data) {
      const item = byId.get(result.offerExternalId)
      if (!item) fail(id, `${name} returned a result for Offer "${result.offerExternalId}", which was not in the call`)
      if (seen.has(result.offerExternalId)) fail(id, `${name} returned two results for Offer "${result.offerExternalId}"`)
      seen.add(result.offerExternalId)
      if (result.outcome === 'ended' && item && item.available !== 0) {
        fail(id, `${name} reported Offer "${result.offerExternalId}" ended after a number above 0`)
      }
    }
  }

  // C9
  const pushStock = capabilities['stock.push']
  if (pushStock) {
    await check('C9', async () => {
      checkResults('C9', 'stock.push', await call('stock.push', () => pushStock(context, [])), stockPushResultSchema, [])
      const sample = offers.slice(0, 3)
      // 0 may end an Offer on a real Channel; a connector that reopens sold-out Offers gets them back with 5.
      for (const available of [0, 5]) {
        const levels: StockLevel[] = sample.map((offer) =>
          stockLevelSchema.parse({ offerExternalId: offer.externalId, sku: offer.sku, available }),
        )
        for (let attempt = 0; attempt < 2; attempt++) {
          checkResults('C9', 'stock.push', await call('stock.push', () => pushStock(context, levels)), stockPushResultSchema, levels)
        }
      }
    })
  }

  // C10
  const updateStatus = capabilities['orders.updateStatus']
  const firstOrder = orders[0]
  if (updateStatus && firstOrder) {
    await check('C10', async () => {
      for (const phase of ORDER_PHASES) {
        for (let attempt = 0; attempt < 2; attempt++) {
          await call('orders.updateStatus', () => updateStatus(context, { orderExternalId: firstOrder.externalId, phase }))
        }
      }
    })
  }

  // C13
  const pushPrice = capabilities['price.push']
  if (pushPrice) {
    await check('C13', async () => {
      // Hanza pushes a price only in the currency the Channel reported for the Offer, so an Offer without a price never gets one.
      const priced = offers.filter((offer) => offerSchema.safeParse(offer).success && offer.price)
      if (priced.length === 0) {
        fail('C13', 'price.push is implemented but no Offer from offers.pull reports a price, so Hanza could never push one')
        return
      }
      checkResults('C13', 'price.push', await call('price.push', () => pushPrice(context, [])), pricePushResultSchema, [])
      for (const amount of ['19.99', '25']) {
        const prices: OfferPrice[] = priced.slice(0, 3).map((offer) =>
          offerPriceSchema.parse({ offerExternalId: offer.externalId, sku: offer.sku, price: { amount, currency: offer.price!.currency } }),
        )
        for (let attempt = 0; attempt < 2; attempt++) {
          checkResults('C13', 'price.push', await call('price.push', () => pushPrice(context, prices)), pricePushResultSchema, prices)
        }
      }
    })
  }

  // S1 to S8: a connector that makes Shipments. One Shipment is created and then repeated, tracked, printed and
  // cancelled (S8, a create against a Carrier that is down, runs after C14).
  const createShipment = capabilities['shipments.create']
  const trackShipments = capabilities['shipments.track']
  const labelShipment = capabilities['shipments.label']
  const cancelShipment = capabilities['shipments.cancel']
  // `as`, not an annotation: S2 assigns it inside a callback, which the compiler does not follow.
  let createdId = null as string | null
  // The request of S2, once S3 has seen that creating it again gives the same Shipment back.
  let repeatableRequest = null as ShipmentRequest | null

  // S1, also without shipments.create: services nobody can use are a mistake in the definition.
  const shipping = shippingProblem(connector)
  if (shipping !== null) fail('S1', shipping)

  // S2 to S7
  if (createShipment) {
    // The core never sends a request that does not fit a declared service, so a fixture that does not proves nothing.
    const usable = (id: string, label: string, raw: unknown): ShipmentRequest | null => {
      const request = shipmentRequestSchema.safeParse(raw)
      if (!request.success) {
        fail(id, `the ${label} fails shipmentRequestSchema: ${z.prettifyError(request.error)}`)
        return null
      }
      // S1 said why; with services that are not well formed there is nothing to fit the request to.
      if (shipping !== null) return null
      const service = findShippingService(connector, request.data.service)
      if (service === undefined) {
        fail(id, `the ${label} names the service "${request.data.service}", which the connector does not declare`)
        return null
      }
      const problem = shipmentRequestProblem(service, request.data)
      if (problem !== null) fail(id, `the ${label} does not fit the service "${service.id}" (${problem}); the core never sends such a request`)
      return problem === null ? request.data : null
    }
    // A new copy for every call, so a connector cannot recognise a repeat by the object.
    const create = (request: ShipmentRequest) => call('shipments.create', () => createShipment(context, structuredClone(request)))
    const shipment = fixtures.shipment
    if (!shipment) fail('S2', 'shipments.create is implemented: pass a shipment fixture')
    const request = shipment ? usable('S2', 'shipment request fixture', shipment.request) : null

    if (shipment && request) {
      await check('S2', async () => {
        const result = shipmentCreateResultSchema.safeParse(await create(request))
        if (!result.success) {
          fail('S2', `shipments.create returned an invalid result: ${z.prettifyError(result.error)}`)
          return
        }
        if (result.data.outcome === 'rejected') {
          fail('S2', `shipments.create rejected the shipment request fixture with code "${result.data.code}"; it must be a request the Carrier accepts`)
          return
        }
        createdId = result.data.externalId
        const { status } = result.data
        if (status !== 'pending' && status !== 'ready') {
          fail(
            'S2',
            `shipments.create returned a Shipment that is already ${status}; a new Shipment is 'pending' or 'ready', since the Carrier cannot have the parcel yet (when recording, use a reference no earlier run used)`,
          )
        }
      })
    }
    const shipmentId = createdId

    if (request && shipmentId !== null) {
      await check('S3', async () => {
        // The core never repeats a create at once; a recording against a real Carrier waits as it would.
        const waitMs = shipment?.repeatWaitMs ?? 0
        if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs))
        const again = shipmentCreateResultSchema.safeParse(await create(request))
        if (!again.success || again.data.outcome !== 'created') {
          fail('S3', 'shipments.create with the same reference did not return the created Shipment the second time')
        } else if (again.data.externalId !== shipmentId) {
          fail('S3', `shipments.create with the same reference returned Shipment "${again.data.externalId}" after "${shipmentId}"; a repeated create must return the Shipment the first one made`)
        } else {
          repeatableRequest = request
        }
      })
    }

    if (trackShipments && shipmentId !== null) {
      await check('S4', async () => {
        // One id the Carrier knows and one it does not: a Shipment that is gone must not cost the others their answer.
        const unknownId = shipment?.unknownExternalId ?? '0'
        if (unknownId === shipmentId) {
          fail('S4', `the unknownExternalId fixture "${unknownId}" is the id of the Shipment shipments.create has just made; give one the Carrier does not know`)
          return
        }
        let tracked: unknown
        try {
          tracked = await call('shipments.track', () => trackShipments(context, [shipmentId, unknownId]))
        } catch (error) {
          fail(
            'S4',
            `shipments.track of Shipment "${shipmentId}" together with "${unknownId}", which the Carrier does not know, failed with ${describeError(error)}; an unknown id is left out of the answer, it never fails the call for the others`,
          )
          return
        }
        const states = z.array(shipmentStateSchema).safeParse(tracked)
        if (!states.success) {
          fail('S4', `shipments.track returned something that is not an array of Shipment states: ${z.prettifyError(states.error)}`)
        } else {
          for (const state of states.data) {
            if (state.externalId === unknownId) {
              fail('S4', `shipments.track returned a state for Shipment "${unknownId}", which the Carrier does not know (the unknownExternalId fixture)`)
            } else if (state.externalId !== shipmentId) {
              fail('S4', `shipments.track returned a state for Shipment "${state.externalId}", which was not asked for`)
            }
          }
          const own = states.data.filter((state) => state.externalId === shipmentId).length
          if (own === 0) {
            fail('S4', `shipments.track returned no state for Shipment "${shipmentId}", which shipments.create has just made, when asked together with the unknown "${unknownId}"`)
          }
          if (own > 1) fail('S4', `shipments.track returned ${own} states for Shipment "${shipmentId}"`)
        }
        let requests = 0
        const counting: typeof fetch = (input, init) => {
          requests++
          return context.fetch(input, init)
        }
        const none: unknown = await call('shipments.track', () => trackShipments({ ...context, fetch: counting }, []))
        if (!Array.isArray(none) || none.length !== 0) fail('S4', 'shipments.track of no Shipments must return an empty array')
        if (requests > 0) fail('S4', 'shipments.track of no Shipments made a request; with nothing to track it must not call the Carrier')
      })
    }

    if (shipment && labelShipment && shipmentId !== null) {
      await check('S5', async () => {
        const attempts = shipment.labelAttempts ?? 10
        const waitMs = shipment.labelWaitMs ?? 0
        for (let attempt = 1; ; attempt++) {
          let label: unknown
          try {
            label = await call('shipments.label', () => labelShipment(context, { externalId: shipmentId }))
          } catch (error) {
            if (!isConnectorError(error) || classifyConnectorError(error).kind !== 'transient') throw error
            if (attempt >= attempts) {
              fail('S5', `shipments.label still failed as 'transient' after ${attempts} attempts, so no Label was ever returned`)
              return
            }
            if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs))
            // What the core does between two attempts; a Carrier double that confirms a Shipment when it is tracked moves on.
            if (trackShipments) await call('shipments.track', () => trackShipments(context, [shipmentId]))
            continue
          }
          const parsed = shipmentLabelSchema.safeParse(label)
          if (!parsed.success) fail('S5', `shipments.label returned an invalid Label (it needs a content type and a non-empty file): ${z.prettifyError(parsed.error)}`)
          return
        }
      })
    }

    const rejected = shipment?.rejected ? usable('S6', 'rejected shipment request fixture', shipment.rejected.request) : null
    if (rejected) {
      await check('S6', async () => {
        if (rejected.reference === request?.reference) {
          fail('S6', 'the rejected shipment request fixture must not share its reference with the shipment request fixture')
          return
        }
        let raw: unknown
        try {
          raw = await create(rejected)
        } catch (error) {
          fail('S6', `shipments.create threw ${describeError(error)} for the rejected fixture; a request the Carrier refuses for good is the outcome 'rejected', not an error`)
          return
        }
        const result = shipmentCreateResultSchema.safeParse(raw)
        if (!result.success) fail('S6', `shipments.create returned an invalid result for the rejected fixture: ${z.prettifyError(result.error)}`)
        else if (result.data.outcome !== 'rejected') {
          fail('S6', `shipments.create made Shipment "${result.data.externalId}" for the rejected fixture; it must return the outcome 'rejected' with a code`)
        }
      })
    }

    // Last: the Shipment may be gone afterwards.
    if (cancelShipment && shipmentId !== null) {
      await check('S7', async () => {
        const outcomes: string[] = []
        for (let attempt = 1; attempt <= 2; attempt++) {
          const result = shipmentCancelResultSchema.safeParse(await call('shipments.cancel', () => cancelShipment(context, { externalId: shipmentId })))
          if (!result.success) {
            fail('S7', `shipments.cancel returned an invalid result (call ${attempt}): ${z.prettifyError(result.error)}`)
            return
          }
          outcomes.push(result.data.outcome)
        }
        if (outcomes[0] === 'cancelled' && outcomes[1] !== 'cancelled') {
          fail('S7', "shipments.cancel returned 'cancelled' and then 'refused' for the same Shipment; a repeated cancel of a cancelled Shipment is 'cancelled'")
        }
      })
    }
  }

  // C11 and C14 need a call that reaches the API with the Connection's credentials: orders.pull, or for a connector
  // without it, shipments.track of the Shipment S2 created.
  const trackedId = createdId
  const trackCreated =
    !pullOrders && trackShipments && trackedId !== null ? (ctx: CapabilityContext) => trackShipments(ctx, [trackedId]) : undefined
  // A create is the one call where a wrong answer costs a Shipment for good (`rejected` is final), so C11, C14 and S8
  // also repeat the create of S2 against a Carrier that refuses or fails. Only once S3 has seen the repeat work: a
  // create that cannot be repeated was reported there. Nothing is made: the Carrier refuses before, or the fetch is
  // not real.
  const repeatedRequest = repeatableRequest
  const createAgain =
    createShipment && repeatedRequest !== null
      ? (ctx: CapabilityContext): Promise<unknown> => createShipment(ctx, structuredClone(repeatedRequest))
      : undefined
  const rejectionCode = (result: unknown): string | null => {
    const parsed = shipmentCreateResultSchema.safeParse(result)
    return parsed.success && parsed.data.outcome === 'rejected' ? parsed.data.code : null
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
      const calls: Array<[name: string, run: (ctx: CapabilityContext) => Promise<unknown>]> = []
      if (pullOrders) calls.push(['orders.pull', (ctx) => pullOrders(ctx, null)])
      else if (trackCreated) calls.push(['shipments.track', trackCreated])
      if (createAgain) calls.push(['shipments.create', createAgain])
      if (calls.length === 0) {
        // A connector that makes Shipments and has none to track failed S1 or S2, which said why.
        if (!createShipment) fail('C11', 'orders.pull is missing, so the unauthorized fixture cannot be exercised')
        return
      }
      const unauthorizedContext: CapabilityContext = {
        ...context,
        credentials: unauthorizedCredentials.data,
        fetch: overrides.fetch ?? context.fetch,
      }
      for (const [name, run] of calls) {
        let result: unknown
        try {
          result = await run(unauthorizedContext)
        } catch (error) {
          const { kind } = classifyConnectorError(error)
          if (kind !== 'auth_expired') fail('C11', `${name} with bad credentials failed as '${kind}', expected 'auth_expired'`)
          continue
        }
        const code = name === 'shipments.create' ? rejectionCode(result) : null
        if (code !== null) {
          fail('C11', `shipments.create with bad credentials returned 'rejected' ("${code}"), which fails the Shipment for good; credentials the Carrier refuses fail the call as 'auth_expired'`)
        } else {
          fail('C11', `${name} with the unauthorized fixture resolved; it must reject`)
        }
      }
    })
  }

  // C14
  const forbiddenCalls: Array<[name: string, run: (ctx: CapabilityContext) => Promise<unknown>]> = []
  if (pullOrders) forbiddenCalls.push(['orders.pull', (ctx) => pullOrders(ctx, null)])
  if (pullOffers) forbiddenCalls.push(['offers.pull', (ctx) => pullOffers(ctx, null)])
  if (trackCreated) forbiddenCalls.push(['shipments.track', trackCreated])
  if (createAgain) forbiddenCalls.push(['shipments.create', createAgain])
  if (fixtures.forbidden !== false && forbiddenCalls.length > 0) {
    await check('C14', async () => {
      const answer = (fixtures.forbidden && fixtures.forbidden.fetch) || (async () => new Response(null, { status: 403, statusText: 'Forbidden' }))
      let requests = 0
      const forbiddenFetch: typeof fetch = (input, init) => {
        requests++
        return answer(input, init)
      }
      for (const [name, run] of forbiddenCalls) {
        try {
          const code = rejectionCode(await call(name, () => run({ ...context, fetch: forbiddenFetch })))
          if (name === 'shipments.create' && code !== null) {
            fail('C14', `shipments.create returned 'rejected' ("${code}") on a 403 Forbidden, which fails the Shipment for good; a 403 refuses the account, not this request, so it is a thrown PermanentError`)
          }
        } catch (error) {
          const { kind } = classifyConnectorError(error)
          if (kind === 'auth_expired') {
            fail('C14', `${name} failed as 'auth_expired' on a 403 Forbidden; without an auth signal a 403 is 'permanent' (no sign-in prompt)`)
          }
        }
      }
      // A connector that talks HTTP (it was given recorded responses) must have met the 403, or the check proved nothing.
      if (fixtures.fetch && requests === 0) fail('C14', `no ${trackCreated ? 'call' : 'pull'} made a request, so the 403 was never seen`)
    })
  }

  // S8: a Carrier that is down. The core retries a thrown create (after its delay); `rejected` would end the Shipment.
  if (createAgain) {
    await check('S8', async () => {
      let requests = 0
      const failingFetch: typeof fetch = async () => {
        requests++
        return new Response(null, { status: 500, statusText: 'Internal Server Error' })
      }
      let result: unknown
      try {
        result = await call('shipments.create', () => createAgain({ ...context, fetch: failingFetch }))
      } catch (error) {
        const { kind } = classifyConnectorError(error)
        // Without a request the failure is not about the 500, and C12 has it if it is not a ConnectorError.
        if (requests > 0 && kind !== 'transient') {
          fail('S8', `shipments.create failed as '${kind}' when the Carrier answered 500 Internal Server Error; a 5xx is 'transient', so the core asks again`)
        }
        return
      }
      // A connector that never touched the network (an in-memory Carrier) was not told anything: nothing to judge.
      if (requests === 0) return
      const code = rejectionCode(result)
      fail(
        'S8',
        code !== null
          ? `shipments.create returned 'rejected' ("${code}") when the Carrier answered 500 Internal Server Error, which fails the Shipment for good; a 5xx is a thrown TransientError`
          : 'shipments.create resolved although the Carrier answered every request 500 Internal Server Error; it must reject as transient',
      )
    })
  }

  const authContext = (fetchOverride?: typeof fetch): AuthContext => ({
    app: context.app,
    config: context.config,
    fetch: fetchOverride ?? context.fetch,
    log: () => {},
  })
  const { auth } = connector
  const isIsoTime = (value: unknown) => value === null || z.iso.datetime({ offset: true }).safeParse(value).success

  // C15
  if (auth.type === 'oauth2' && (auth.refresh || auth.expiresAt)) {
    await check('C15', async () => {
      if (auth.expiresAt && !isIsoTime(auth.expiresAt(context.credentials))) {
        fail('C15', 'auth.expiresAt must return null or an ISO datetime with an offset')
      }
      if (!auth.refresh) return
      if (!fixtures.refresh) {
        fail('C15', 'auth.refresh is implemented: pass a refresh fixture')
        return
      }
      const refreshed = await call('auth.refresh', () => auth.refresh!(authContext(fixtures.refresh!.fetch), context.credentials))
      const parsed = connector.credentialsSchema.safeParse(refreshed)
      if (!parsed.success) fail('C15', 'auth.refresh returned credentials that credentialsSchema rejects')
      else if (auth.expiresAt && !isIsoTime(auth.expiresAt(parsed.data))) {
        fail('C15', 'auth.expiresAt of the refreshed credentials must return null or an ISO datetime with an offset')
      }
      const refused = fixtures.refresh.refused
      if (!refused) return
      let value = context.credentials
      if (refused.credentials !== undefined) {
        const parsedRefused = connector.credentialsSchema.safeParse(refused.credentials)
        if (!parsedRefused.success) {
          fail('C15', 'credentialsSchema rejects the refused refresh credentials fixture')
          return
        }
        value = parsedRefused.data
      }
      try {
        await call('auth.refresh', () => auth.refresh!(authContext(refused.fetch ?? fixtures.refresh!.fetch), value))
      } catch (error) {
        const { kind } = classifyConnectorError(error)
        if (kind !== 'auth_expired') fail('C15', `a refused auth.refresh failed as '${kind}', expected 'auth_expired'`)
        return
      }
      fail('C15', 'auth.refresh with the refused fixture resolved; it must reject')
    })
  }

  // C16
  const deviceFlow = auth.type === 'oauth2' ? auth.deviceFlow : undefined
  if (deviceFlow) {
    await check('C16', async () => {
      if (!fixtures.deviceFlow) {
        fail('C16', 'auth.deviceFlow is implemented: pass a deviceFlow fixture')
        return
      }
      const authCtx = authContext(fixtures.deviceFlow.fetch)
      const started = deviceSignInStartSchema.safeParse(await call('deviceFlow.start', () => deviceFlow.start(authCtx)))
      if (!started.success) {
        fail('C16', `deviceFlow.start returned an invalid result: ${z.prettifyError(started.error)}`)
        return
      }
      const { verificationUri, verificationUriComplete, deviceCode } = started.data
      if (!isAllowedVerificationUri(verificationUri, deviceFlow.verificationHosts)) {
        fail('C16', 'verificationUri must be an https: URL on one of verificationHosts')
      }
      if (verificationUriComplete !== null && !isAllowedVerificationUri(verificationUriComplete, deviceFlow.verificationHosts)) {
        fail('C16', 'verificationUriComplete must be null or an https: URL on one of verificationHosts')
      }
      const polled = deviceSignInPollSchema.safeParse(await call('deviceFlow.poll', () => deviceFlow.poll(authCtx, deviceCode)))
      if (!polled.success) {
        fail('C16', `deviceFlow.poll returned an invalid result: ${z.prettifyError(polled.error)}`)
        return
      }
      if (polled.data.status === 'approved' && !connector.credentialsSchema.safeParse(polled.data.credentials).success) {
        fail('C16', 'deviceFlow.poll approved with credentials that credentialsSchema rejects')
      }
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
