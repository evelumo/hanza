// Test tooling only: never imported by the connector itself.
//
// A Medusa store with medusa-plugin-hanza in memory, as far as the connector uses it: the plugin's three routes (wire
// format 1), the variant and order lists with Medusa's query syntax (`id[]=`, `created_at[$gte]=`, `order=-created_at`,
// `offset`, `limit`), one order, fulfillments, shipments and the cancel. Unlike a cassette it can change between two
// requests of one call (`beforeAnswer`), which is where a feed loses orders. It ignores `fields` and answers whole
// objects. The journal has no hold-back: an entry is visible at once.
import type { MedusaContext } from '../settings'
import { replayConfig, replayCredentials } from './recording'
import { raw, rawAddress, rawItem, rawOrder, rawPayment, rawVariant, type Json } from './samples'

export interface FakeRequest {
  method: string
  path: string
  /** In the order sent, repeated names included. */
  query: Array<[string, string]>
  body: unknown
}

export interface JournalEntry {
  seq: number
  type: string
  order_id: string
  occurred_at: string
}

export interface FakeSettings {
  stock_location_id: string | null
  sales_channel_ids: string[]
  pay_on_delivery_provider_ids: string[]
  paid_when: 'captured' | 'authorized'
  notify_customer_on_shipment: boolean
  journal_retention_days: number
  currency_code: string | null
}

const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8' }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_TYPE })
}

function error(status: number, type: string, message: string, extra: Json = {}): Response {
  return json({ type, message, ...extra }, status)
}

const stamp = (ms: number) => new Date(ms).toISOString()

export class FakeMedusa {
  apiKey = replayCredentials.apiKey
  /** False: every `/admin/hanza/*` route answers 404, as on a store without the plugin. */
  pluginInstalled = true
  /** The wire format the plugin answers with. */
  format: unknown = 1
  pluginVersion = '0.1.0'
  defaultCurrency: string | null = 'pln'
  settings: FakeSettings = {
    stock_location_id: 'sloc_01MAIN',
    sales_channel_ids: [],
    pay_on_delivery_provider_ids: [],
    paid_when: 'captured',
    notify_customer_on_shipment: true,
    journal_retention_days: 60,
    currency_code: null,
  }
  /** The highest seq the retention job deleted: `after` below it answers 410 `journal_expired`. */
  prunedThroughSeq = 0
  /** Answers 403 to every request, as for a key whose user may not do this. */
  forbidden = false
  /** Called before each answer with the number of requests so far: the place to change the store mid-call. */
  beforeAnswer: ((count: number, request: FakeRequest) => void) | null = null
  readonly requests: FakeRequest[] = []
  readonly logs: Array<{ message: string; fields?: Record<string, unknown> }> = []
  /** Availability set through the plugin, per variant. */
  readonly stock = new Map<string, number>()
  /** `no_notification` of every shipment made, in order. */
  readonly shipmentNotifications: boolean[] = []
  nowMs: number

  private readonly variants = new Map<string, Json>()
  private readonly orders = new Map<string, Json>()
  private readonly journal: JournalEntry[] = []
  private nextSeq = 1
  private nextId = 1

  constructor(start = '2026-10-11T10:00:00.000Z') {
    this.nowMs = Date.parse(start)
  }

  tick(seconds = 1): this {
    this.nowMs += seconds * 1000
    return this
  }

  get now(): string {
    return stamp(this.nowMs)
  }

  /** Journal entries are numbered from `seq` on (as if older ones existed and were pruned). */
  startJournalAt(seq: number): this {
    this.nextSeq = seq
    return this
  }

  record(type: string, orderId: string): number {
    const seq = this.nextSeq++
    this.journal.push({ seq, type, order_id: orderId, occurred_at: this.now })
    return seq
  }

  get newestSeq(): number | null {
    return this.journal.at(-1)?.seq ?? null
  }

  variant(id: string, overrides: Json = {}): this {
    this.variants.set(id, rawVariant(id, overrides))
    return this
  }

  deleteVariant(id: string): this {
    this.variants.delete(id)
    return this
  }

  /**
   * A new order, created now, with an `order.placed` entry unless `journal` is false (an order from before the
   * journal's position). Paid online and captured, one line, unfulfilled, unless the overrides say otherwise.
   */
  place(overrides: Json = {}, journal = true): string {
    const id = (overrides.id as string | undefined) ?? `order_${String(this.nextId++).padStart(3, '0')}`
    const payments = [rawPayment(`pay_${id}`, { captured_at: this.now, captured_amount: 114.98 })]
    const order = rawOrder(id, { created_at: this.now, updated_at: this.now, payment_collections: [{ id: `paycol_${id}`, payments }], ...overrides })
    this.orders.set(id, order)
    if (journal) this.record('order.placed', id)
    return id
  }

  /** An order placed unpaid: the payment authorized, not captured. */
  placeUnpaid(overrides: Json = {}, journal = true): string {
    return this.place(
      {
        payment_status: 'authorized',
        payment_collections: [{ id: 'paycol_unpaid', payments: [rawPayment('pay_unpaid', { captured_at: null })] }],
        ...overrides,
      },
      journal,
    )
  }

  get(id: string): Json {
    const order = this.orders.get(id)
    if (order === undefined) throw new Error(`fake medusa: no order ${id}`)
    return order
  }

  update(id: string, changes: Json, entry: string | null = 'order.updated'): this {
    this.orders.set(id, { ...this.get(id), ...changes, updated_at: this.now })
    if (entry !== null) this.record(entry, id)
    return this
  }

  capture(id: string): this {
    const order = this.get(id)
    const collections = (order.payment_collections as Json[]).map((collection) => ({
      ...collection,
      payments: (collection.payments as Json[]).map((payment) => ({ ...payment, captured_at: this.now, captured_amount: payment.amount })),
    }))
    return this.update(id, { payment_status: 'captured', payment_collections: collections }, 'payment.captured')
  }

  /** Fulfils every unfulfilled item and ships it, as a person would in Medusa's admin. */
  shipAll(id: string): this {
    this.fulfil(id, this.unfulfilled(id), null)
    for (const fulfillment of this.get(id).fulfillments as Json[]) {
      if (!fulfillment.shipped_at && !fulfillment.canceled_at) this.shipFulfillment(id, String(fulfillment.id), true)
    }
    return this
  }

  cancelOrder(id: string): this {
    return this.update(id, { status: 'canceled', canceled_at: this.now, payment_status: 'canceled' }, 'order.canceled')
  }

  /** Removes an order from every list, as if Medusa no longer had it. */
  remove(id: string): this {
    this.orders.delete(id)
    return this
  }

  context(credentials = replayCredentials): MedusaContext {
    return {
      app: {},
      config: replayConfig,
      credentials,
      fetch: this.fetch,
      log: (message, fields) => {
        this.logs.push(fields === undefined ? { message } : { message, fields })
      },
    }
  }

  /** The requests so far as `METHOD path?query`, decoded, in the order and spelling the connector sent them. */
  get urls(): string[] {
    return this.requests.map(({ method, path, query }) => {
      const search = query.map(([name, value]) => `${name}=${value}`).join('&')
      return `${method} ${path}${search === '' ? '' : `?${search}`}`
    })
  }

  /** The bodies of the writes so far, with their paths. */
  get writes(): Array<{ path: string; body: unknown }> {
    return this.requests.filter((request) => request.method !== 'GET').map(({ path, body }) => ({ path, body }))
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const incoming = new Request(input, init)
    const url = new URL(incoming.url)
    const text = incoming.method === 'GET' ? '' : await incoming.text()
    const request: FakeRequest = {
      method: incoming.method,
      path: url.pathname.replace(/^\/admin\//, ''),
      query: [...url.searchParams.entries()],
      body: text === '' ? undefined : JSON.parse(text),
    }
    this.requests.push(request)
    this.beforeAnswer?.(this.requests.length, request)
    if (incoming.headers.get('authorization') !== `Basic ${this.apiKey}`) return new Response('Unauthorized', { status: 401, headers: { 'content-type': 'text/plain' } })
    if (this.forbidden) return error(403, 'not_allowed', 'Forbidden')
    return this.answer(request)
  }

  private param(request: FakeRequest, name: string): string | undefined {
    return request.query.find(([key]) => key === name)?.[1]
  }

  private list(request: FakeRequest, name: string): string[] | undefined {
    const values = request.query.filter(([key]) => key === `${name}[]`).map(([, value]) => value)
    return values.length === 0 ? undefined : values
  }

  private plugin(): Json {
    return { format: this.format, plugin: { name: 'medusa-plugin-hanza', version: this.pluginVersion } }
  }

  private answer(request: FakeRequest): Response {
    const { method, path } = request
    if (path.startsWith('hanza/')) {
      if (!this.pluginInstalled) return error(404, 'not_found', `Cannot ${method} /admin/${path}`)
      if (method === 'GET' && path === 'hanza/status') return this.status()
      if (method === 'GET' && path === 'hanza/journal') return this.journalPage(request)
      if (method === 'POST' && path === 'hanza/stock') return this.pushStock(request)
      return error(404, 'not_found', 'Not found')
    }
    if (method === 'GET' && path === 'product-variants') return this.listVariants(request)
    if (method === 'GET' && path === 'orders') return this.listOrders(request)
    const single = /^orders\/([^/]+)(\/.*)?$/.exec(path)
    if (single === null) return error(404, 'not_found', 'Not found')
    const id = decodeURIComponent(single[1]!)
    const rest = single[2] ?? ''
    if (!this.orders.has(id)) return error(404, 'not_found', `Order with id: ${id} was not found`)
    if (method === 'GET' && rest === '') return json({ order: this.get(id) })
    if (method === 'POST' && rest === '/fulfillments') return this.createFulfillment(id, request.body as Json)
    const shipment = /^\/fulfillments\/([^/]+)\/shipments$/.exec(rest)
    if (method === 'POST' && shipment !== null) return this.createShipment(id, decodeURIComponent(shipment[1]!), request.body as Json)
    if (method === 'POST' && rest === '/cancel') return this.cancel(id)
    return error(404, 'not_found', 'Not found')
  }

  private status(): Response {
    return json({
      ...this.plugin(),
      store: { default_currency_code: this.defaultCurrency },
      settings: this.settings,
      journal: { oldest_seq: this.journal[0]?.seq ?? null, newest_seq: this.newestSeq },
    })
  }

  private journalPage(request: FakeRequest): Response {
    const after = this.param(request, 'after')
    const limit = Number(this.param(request, 'limit') ?? 100)
    if (after === undefined || !/^\d+$/.test(after) || !Number.isInteger(limit) || limit < 1 || limit > 500) {
      return error(400, 'invalid_data', 'Invalid request')
    }
    if (Number(after) < this.prunedThroughSeq) {
      return error(410, 'gone', 'The journal no longer has this position', { code: 'journal_expired', oldest_seq: this.prunedThroughSeq + 1 })
    }
    const entries = this.journal.filter((entry) => entry.seq > Number(after)).slice(0, limit)
    return json({ ...this.plugin(), entries, newest_seq: this.newestSeq })
  }

  private pushStock(request: FakeRequest): Response {
    if (this.settings.stock_location_id === null) {
      return error(409, 'conflict', 'Pick a stock location in Extensions → Hanza', { code: 'stock_location_not_set' })
    }
    const levels = (request.body as { levels?: Array<{ variant_id: string; available: number }> } | undefined)?.levels
    if (!Array.isArray(levels) || levels.length === 0 || levels.length > 100) return error(400, 'invalid_data', 'Invalid request')
    const results = levels.map(({ variant_id, available }) => {
      const variant = this.variants.get(variant_id)
      if (variant === undefined) return { variant_id, outcome: 'rejected', code: 'unknown_variant' }
      if (variant.manage_inventory === false) return { variant_id, outcome: 'rejected', code: 'inventory_not_managed' }
      if (variant.kit === true) return { variant_id, outcome: 'rejected', code: 'inventory_kit' }
      this.stock.set(variant_id, available)
      return { variant_id, outcome: 'ok' }
    })
    return json({ ...this.plugin(), results })
  }

  private page<T>(request: FakeRequest, items: T[], key: string): Response {
    const offset = Number(this.param(request, 'offset') ?? 0)
    const limit = Number(this.param(request, 'limit') ?? 50)
    return json({ [key]: items.slice(offset, offset + limit), count: items.length, offset, limit })
  }

  private listVariants(request: FakeRequest): Response {
    if (this.param(request, 'order') !== 'id') return error(400, 'invalid_data', 'fake medusa: variants are listed by id only')
    const variants = [...this.variants.values()].sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1))
    return this.page(request, variants, 'variants')
  }

  private listOrders(request: FakeRequest): Response {
    let orders = [...this.orders.values()].filter((order) => order.is_draft_order !== true)
    const ids = this.list(request, 'id')
    if (ids !== undefined) orders = orders.filter((order) => ids.includes(String(order.id)))
    const statuses = this.list(request, 'status')
    if (statuses !== undefined) orders = orders.filter((order) => statuses.includes(String(order.status)))
    const channels = this.list(request, 'sales_channel_id')
    if (channels !== undefined) orders = orders.filter((order) => channels.includes(String(order.sales_channel_id)))
    const bounds: Array<[string, (a: number, b: number) => boolean]> = [
      ['created_at[$gte]', (a, b) => a >= b],
      ['created_at[$gt]', (a, b) => a > b],
      ['created_at[$lte]', (a, b) => a <= b],
      ['created_at[$lt]', (a, b) => a < b],
    ]
    for (const [name, keep] of bounds) {
      const value = this.param(request, name)
      if (value === undefined) continue
      if (Number.isNaN(Date.parse(value))) return error(400, 'invalid_data', `Invalid ${name}`)
      orders = orders.filter((order) => keep(Date.parse(String(order.created_at)), Date.parse(value)))
    }
    const order = this.param(request, 'order')
    const time = (item: Json) => Date.parse(String(item.created_at))
    if (order === 'created_at' || order === '-created_at') {
      const direction = order === 'created_at' ? 1 : -1
      // Medusa sorts on one field: orders of one millisecond come in no particular order. Here: by id, backwards.
      orders.sort((a, b) => direction * (time(a) - time(b)) || (String(a.id) < String(b.id) ? 1 : -1))
    } else if (order === 'id') {
      orders.sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1))
    } else if (order !== undefined) {
      return error(400, 'invalid_data', 'fake medusa: unknown order')
    }
    return this.page(request, orders, 'orders')
  }

  private unfulfilled(id: string): Array<{ id: string; quantity: number }> {
    const order = this.get(id)
    const done = new Map<string, number>()
    for (const fulfillment of order.fulfillments as Json[]) {
      if (fulfillment.canceled_at) continue
      for (const item of fulfillment.items as Json[]) done.set(String(item.line_item_id), (done.get(String(item.line_item_id)) ?? 0) + Number(item.quantity))
    }
    return (order.items as Json[])
      .map((item) => ({ id: String(item.id), quantity: Number(item.quantity) - (done.get(String(item.id)) ?? 0) }))
      .filter((item) => item.quantity > 0)
  }

  private refreshFulfillmentStatus(id: string): string {
    const order = this.get(id)
    const live = (order.fulfillments as Json[]).filter((fulfillment) => !fulfillment.canceled_at)
    const quantities = (order.items as Json[]).reduce((sum, item) => sum + Number(item.quantity), 0)
    const counted = (shippedOnly: boolean) =>
      live.filter((fulfillment) => !shippedOnly || fulfillment.shipped_at).flatMap((fulfillment) => fulfillment.items as Json[]).reduce((sum, item) => sum + Number(item.quantity), 0)
    const [fulfilled, shipped] = [counted(false), counted(true)]
    if (shipped >= quantities) return 'shipped'
    if (shipped > 0) return 'partially_shipped'
    if (fulfilled >= quantities) return 'fulfilled'
    return fulfilled > 0 ? 'partially_fulfilled' : 'not_fulfilled'
  }

  /** A fulfillment of these items; null location = the order's shipping option's. Returns its id. */
  fulfil(id: string, items: Array<{ id: string; quantity: number }>, locationId: string | null): string {
    const order = this.get(id)
    const fulfillmentId = `ful_${id}_${(order.fulfillments as Json[]).length + 1}`
    const fulfillment = {
      id: fulfillmentId,
      location_id: locationId ?? 'sloc_01MAIN',
      shipped_at: null,
      delivered_at: null,
      canceled_at: null,
      items: items.map((item, index) => ({ id: `fulitem_${fulfillmentId}_${index + 1}`, line_item_id: item.id, quantity: item.quantity })),
    }
    this.orders.set(id, { ...order, fulfillments: [...(order.fulfillments as Json[]), fulfillment], updated_at: this.now })
    this.orders.set(id, { ...this.get(id), fulfillment_status: this.refreshFulfillmentStatus(id) })
    this.record('order.fulfillment_created', id)
    return fulfillmentId
  }

  shipFulfillment(id: string, fulfillmentId: string, notify: boolean): this {
    const order = this.get(id)
    const fulfillments = (order.fulfillments as Json[]).map((fulfillment) => (fulfillment.id === fulfillmentId ? { ...fulfillment, shipped_at: this.now } : fulfillment))
    this.orders.set(id, { ...order, fulfillments, updated_at: this.now })
    this.orders.set(id, { ...this.get(id), fulfillment_status: this.refreshFulfillmentStatus(id) })
    this.shipmentNotifications.push(!notify)
    this.record('shipment.created', id)
    return this
  }

  private createFulfillment(id: string, body: Json): Response {
    const items = body?.items as Array<{ id: string; quantity: number }> | undefined
    if (!Array.isArray(items) || items.length === 0) return error(400, 'invalid_data', 'Invalid request')
    const open = new Map(this.unfulfilled(id).map((item) => [item.id, item.quantity]))
    if (items.some((item) => (open.get(item.id) ?? 0) < item.quantity)) return error(400, 'invalid_data', 'Cannot fulfill more items than ordered')
    this.fulfil(id, items, (body.location_id as string | undefined) ?? null)
    return json({ order: this.get(id) })
  }

  private createShipment(id: string, fulfillmentId: string, body: Json): Response {
    const fulfillment = (this.get(id).fulfillments as Json[]).find((candidate) => candidate.id === fulfillmentId)
    if (fulfillment === undefined) return error(404, 'not_found', 'Fulfillment not found')
    if (fulfillment.shipped_at) return error(400, 'not_allowed', 'Already shipped')
    if (!Array.isArray(body?.items) || (body.items as unknown[]).length === 0) return error(400, 'invalid_data', 'Invalid request')
    this.orders.set(id, this.get(id))
    this.shipFulfillment(id, fulfillmentId, body.no_notification !== true)
    return json({ order: this.get(id) })
  }

  private cancel(id: string): Response {
    const order = this.get(id)
    const captured = (order.payment_collections as Json[]).some((collection) => (collection.payments as Json[]).some((payment) => payment.captured_at))
    const live = (order.fulfillments as Json[]).some((fulfillment) => !fulfillment.canceled_at)
    if (captured || live) return error(409, 'not_allowed', 'Order cannot be canceled')
    this.cancelOrder(id)
    return json({ order: this.get(id) })
  }
}

/** Builders re-exported for tests that make objects by hand. */
export { raw, rawAddress, rawItem, rawOrder, rawPayment, rawVariant }
