// Test tooling only: never imported by the connector itself.
//
// The orders API of a WooCommerce shop in memory, as far as the Order feed uses it, behaving as WooCommerce 11.2.1
// (HPOS) did on the sandbox: lists ordered by a time of second resolution and then by id, strict date filters,
// `status=any` without the trash, `offset`, `_fields`, a `Date` header from the shop's own clock, and a `PUT` that
// takes an order out of the trash, and a 400 for a status nobody registered.
// Unlike a cassette it can change between two requests of one call, which is where a feed loses orders. It refuses a
// date filter in any format but the one the real shop reads correctly.
import type { WooCommerceContext } from '../settings'
import { replayConfig, replayCredentials } from './recording'
import { rawLine, rawOrder } from './samples'

type Json = Record<string, unknown>

export interface ShopRequest {
  method: string
  path: string
  query: Record<string, string>
  body: unknown
}

const DATE_FILTER = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const HIDDEN_FROM_ANY = ['trash', 'checkout-draft', 'auto-draft']
/** WooCommerce's own statuses, in the order its report lists them. */
const CORE_STATUSES = ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed', 'checkout-draft']

const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19)

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=UTF-8', ...headers } })
}

export class FakeShop {
  /** The shop's clock. */
  nowMs: number
  /** False for a shop (or proxy) that sends no `Date` header. */
  sendsDate = true
  /** What `GET products` answers instead of the products, e.g. 403 for a key that may not read them. */
  productsStatus: number | null = null
  /** The statuses registered in the shop: WooCommerce's own and, as on the sandbox, a plugin's `packing`. */
  statuses: string[] = [...CORE_STATUSES, 'packing']
  /** Called before the shop answers each request, with the number of requests so far: the place to change the shop mid-call. */
  beforeAnswer: ((count: number, request: ShopRequest) => void) | null = null
  readonly requests: ShopRequest[] = []
  readonly logs: Array<{ message: string; fields?: Record<string, unknown> }> = []

  private readonly orders = new Map<number, Json>()
  private readonly products = new Map<number, string>()
  private readonly statusBeforeTrash = new Map<number, unknown>()
  private nextId = 1

  constructor(start = '2026-10-10T12:00:00Z') {
    this.nowMs = Date.parse(start)
  }

  get second(): number {
    return Math.floor(this.nowMs / 1000)
  }

  tick(seconds = 1): this {
    this.nowMs += seconds * 1000
    return this
  }

  /** A product or the parent of variations, with its SKU (`''` for none). */
  product(id: number, sku: string): this {
    this.products.set(id, sku)
    return this
  }

  /** A new order, stamped now unless the overrides say otherwise. Paid online and `processing` by default; one line. */
  place(overrides: Json = {}): number {
    const id = (overrides.id as number | undefined) ?? this.nextId
    this.nextId = Math.max(this.nextId, id) + 1
    const now = stamp(this.nowMs)
    this.orders.set(id, {
      ...rawOrder({ line_items: [rawLine(2)], date_created_gmt: now, date_paid_gmt: now, date_completed_gmt: null }),
      date_modified_gmt: now,
      ...overrides,
      id,
    })
    return id
  }

  /** Saves changes to an order, which stamps `date_modified` with the shop's clock (HPOS does on every save). */
  save(id: number, changes: Json = {}): this {
    const order = this.orders.get(id)
    if (order === undefined) throw new Error(`fake shop: no order ${id}`)
    this.orders.set(id, { ...order, ...changes, date_modified_gmt: (changes.date_modified_gmt as string | undefined) ?? stamp(this.nowMs) })
    return this
  }

  pay(id: number): this {
    return this.save(id, { status: 'processing', date_paid_gmt: stamp(this.nowMs) })
  }

  complete(id: number): this {
    const now = stamp(this.nowMs)
    return this.save(id, { status: 'completed', date_completed_gmt: now, date_paid_gmt: this.get(id).date_paid_gmt ?? now })
  }

  cancel(id: number): this {
    return this.save(id, { status: 'cancelled' })
  }

  trash(id: number): this {
    this.statusBeforeTrash.set(id, this.get(id).status)
    return this.save(id, { status: 'trash' })
  }

  /** Takes an order out of the trash, back into the status it had. */
  restore(id: number): this {
    return this.save(id, { status: this.statusBeforeTrash.get(id) ?? 'pending' })
  }

  /** The ids of every order the shop has, drafts and trash included. */
  get ids(): number[] {
    return [...this.orders.keys()]
  }

  /** Deletes for good: the order is gone from every list. */
  remove(id: number): this {
    this.orders.delete(id)
    return this
  }

  get(id: number): Json {
    const order = this.orders.get(id)
    if (order === undefined) throw new Error(`fake shop: no order ${id}`)
    return order
  }

  context(): WooCommerceContext {
    return {
      app: {},
      config: replayConfig,
      credentials: replayCredentials,
      fetch: this.fetch,
      log: (message, fields) => {
        this.logs.push({ message, fields })
      },
    }
  }

  /** The requests made so far as `METHOD path?query`, in the order and spelling the connector sent them. */
  get urls(): string[] {
    return this.requests.map(({ method, path, query }) => {
      const search = Object.entries(query)
        .map(([name, value]) => `${name}=${value}`)
        .join('&')
      return `${method} ${path}${search === '' ? '' : `?${search}`}`
    })
  }

  readonly fetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const request: ShopRequest = {
      method: init.method ?? 'GET',
      path: url.pathname.replace(/^\/wp-json\/wc\/v3\//, ''),
      query: Object.fromEntries(url.searchParams),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    this.requests.push(request)
    this.beforeAnswer?.(this.requests.length, request)
    const headers: Record<string, string> = this.sendsDate ? { date: new Date(this.nowMs).toUTCString() } : {}
    const [status, body] = this.answer(request)
    return json(body, status, headers)
  }

  private answer(request: ShopRequest): [number, unknown] {
    const { method, path, query } = request
    const error = (status: number, code: string): [number, unknown] => [status, { code, message: 'An error.', data: { status } }]
    const fields = query._fields?.split(',')
    const cut = (item: Json) => (fields === undefined ? item : Object.fromEntries(fields.filter((field) => field in item).map((field) => [field, item[field]])))

    if (method === 'GET' && path === 'products') {
      if (this.productsStatus !== null) return error(this.productsStatus, 'woocommerce_rest_cannot_view')
      const include = (query.include ?? '').split(',').map(Number)
      if (include.length > Number(query.per_page ?? 10)) return error(400, 'fake_shop_include_above_per_page')
      return [200, include.filter((id) => this.products.has(id)).map((id) => cut({ id, sku: this.products.get(id), name: 'A product' }))]
    }
    if (method === 'GET' && path === 'orders') return this.list(query, cut, error)

    const single = /^orders\/(\d+)$/.exec(path)
    if (single === null) return error(404, 'rest_no_route')
    const id = Number(single[1])
    const order = this.orders.get(id)
    if (method === 'GET') return order === undefined ? error(404, 'woocommerce_rest_shop_order_invalid_id') : [200, cut(order)]
    if (method === 'PUT') {
      if (order === undefined) return error(400, 'woocommerce_rest_shop_order_invalid_id')
      // Any update takes an order out of the trash, and even the status it already has stamps `date_modified`.
      this.save(id, request.body as Json)
      return [200, cut(this.get(id))]
    }
    return error(404, 'rest_no_route')
  }

  private list(query: Record<string, string>, cut: (item: Json) => Json, error: (status: number, code: string) => [number, unknown]): [number, unknown] {
    if ('dates_are_gmt' in query) return error(400, 'fake_shop_dates_are_gmt')
    const filters: Array<[string, string]> = [
      ['after', 'date_created_gmt'],
      ['modified_after', 'date_modified_gmt'],
    ]
    let orders = [...this.orders.values()]
    for (const [parameter, field] of filters) {
      const value = query[parameter]
      if (value === undefined) continue
      if (!DATE_FILTER.test(value)) return error(400, `fake_shop_${parameter}_format`)
      const after = stamp(Date.parse(value))
      orders = orders.filter((order) => String(order[field]) > after)
    }
    const statuses = (query.status ?? 'any').split(',')
    // The parameter is checked against the registered statuses, like on the real shop.
    if (statuses.some((status) => !['any', 'trash', 'auto-draft', ...this.statuses].includes(status))) return error(400, 'rest_invalid_param')
    // `any` replaces the whole list, as on the real shop: the trash cannot be asked for along with it.
    orders = statuses.includes('any')
      ? orders.filter((order) => !HIDDEN_FROM_ANY.includes(String(order.status)))
      : orders.filter((order) => statuses.includes(String(order.status)))

    const column = { id: 'id', date: 'date_created_gmt', modified: 'date_modified_gmt' }[query.orderby ?? 'date']
    if (column === undefined) return error(400, 'rest_invalid_param')
    const direction = query.order === 'asc' ? 1 : -1
    const compare = (a: unknown, b: unknown) => (a === b ? 0 : (a as number | string) < (b as number | string) ? -1 : 1)
    orders.sort((a, b) => direction * (compare(a[column], b[column]) || compare(a.id, b.id)))

    const offset = Number(query.offset ?? 0)
    return [200, orders.slice(offset, offset + Number(query.per_page ?? 10)).map(cut)]
  }
}
