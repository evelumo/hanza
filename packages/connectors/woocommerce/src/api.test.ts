import { describe, expect, it } from 'vitest'
import {
  WOO_MAX_PER_PAGE,
  WOO_NAME_MAX,
  WOO_ORDER_FIELDS,
  WOO_PRODUCT_FIELDS,
  WOO_PRODUCT_TYPE_FIELDS,
  WOO_VARIATION_FIELDS,
  wooBatchResponseSchema,
  wooCurrencySchema,
  wooOrderIdsSchema,
  WOO_LINE_ITEMS_MAX,
  WOO_ORDERS_PER_PAGE_MAX,
  wooOrderSchema,
  wooOrdersSchema,
  wooOrderStatusSchema,
  wooProductSchema,
  wooProductsSchema,
  wooProductTypesSchema,
  wooVariationSchema,
  wooVariationsSchema,
} from './api'
import { rawLine, rawOrder, rawSimpleProduct, rawVariableProduct, rawVariation } from './testing/samples'

describe('wooOrderSchema', () => {
  it('reads the parts of an order the connector uses, and nothing else', () => {
    const order = wooOrderSchema.parse(rawOrder())
    expect(order).toMatchObject({
      id: 39,
      status: 'processing',
      currency: 'PLN',
      date_created_gmt: '2026-09-21T07:20:00',
      date_modified_gmt: '2026-10-10T19:01:48',
      date_paid_gmt: '2026-09-21T07:22:00',
      date_completed_gmt: null,
      total: '426.96',
      payment_method: 'przelewy24',
    })
    expect(order.line_items[1]).toEqual({ id: 27, name: 'Koszulka testowa - M', product_id: 19, variation_id: 21, quantity: 1, total: '63.07', total_tax: '14.50', sku: 'WOO-TSHIRT' })
    // The Buyer's IP address, the order key and the rest never leave the parser.
    expect(Object.keys(order).sort()).toEqual(
      ['billing', 'currency', 'date_completed_gmt', 'date_created_gmt', 'date_modified_gmt', 'date_paid_gmt', 'id', 'line_items', 'payment_method', 'shipping', 'status', 'total'].sort(),
    )
  })

  it('does not fail on a key it does not know', () => {
    expect(wooOrderSchema.safeParse(rawOrder({ a_plugins_field: { nested: [1, 2, 3] }, line_items: [rawLine(0, { bundled_by: 'x' })] })).success).toBe(true)
  })

  it('reads a deleted product\'s line: no product id, a null SKU', () => {
    const line = wooOrderSchema.parse(rawOrder({ line_items: [rawLine(0, { product_id: 0, variation_id: 0, sku: null, parent_name: null })] })).line_items[0]
    expect(line).toMatchObject({ product_id: 0, variation_id: 0, sku: '' })
  })

  it('reads a null or missing text like WooCommerce\'s empty string', () => {
    const order = wooOrderSchema.parse(rawOrder({ payment_method: null, shipping: { first_name: null, country: null } }))
    expect(order.payment_method).toBe('')
    expect(order.shipping).toEqual({ first_name: '', last_name: '', company: '', address_1: '', address_2: '', city: '', state: '', postcode: '', country: '', phone: '', email: '' })
  })

  it('reads an order that was never paid or completed', () => {
    expect(wooOrderSchema.parse(rawOrder({ date_paid_gmt: null, date_completed_gmt: null }))).toMatchObject({ date_paid_gmt: null, date_completed_gmt: null })
    const { date_paid_gmt: _paid, date_completed_gmt: _completed, ...without } = rawOrder()
    expect(wooOrderSchema.parse(without)).toMatchObject({ date_paid_gmt: null, date_completed_gmt: null })
  })

  it.each([
    ['an id that is not a number', { id: '39' }, ['id']],
    ['no status', { status: '' }, ['status']],
    ['a date with an offset, which would be read as UTC twice', { date_modified_gmt: '2026-10-10T19:01:48+02:00' }, ['date_modified_gmt']],
    ['a date without a time', { date_created_gmt: '2026-09-21' }, ['date_created_gmt']],
    ['a total that is a number', { total: 426.96 }, ['total']],
    ['lines that are not a list', { line_items: {} }, ['line_items']],
  ])('refuses %s', (_, overrides, paths) => {
    const result = wooOrderSchema.safeParse(rawOrder(overrides))
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual(paths)
  })

  it('reads a list of orders', () => {
    expect(wooOrdersSchema.parse([rawOrder(), rawOrder({ id: 40 })]).map((order) => order.id)).toEqual([39, 40])
    expect(wooOrdersSchema.parse([])).toEqual([])
  })
})

describe('wooOrderSchema: dates that only say when a fact happened', () => {
  it.each([
    ['what WooCommerce before 3.0 wrote for "never"', '-0001-11-30T00:00:00'],
    ['a zero date', '0000-00-00T00:00:00'],
    ['an empty string', ''],
    ['a date without a time', '2026-09-21'],
    ['a date with an offset', '2026-09-21T07:22:00+02:00'],
    ['a month that does not exist', '2026-13-01T00:00:00'],
    ['a number', 1_790_000_000],
    ['an object', { date: '2026-09-21 07:22:00' }],
    ['a megabyte of text', 'x'.repeat(1_000_000)],
  ])('reads %s as not set, for both dates, without failing the order', (_, value) => {
    const order = wooOrderSchema.parse(rawOrder({ date_paid_gmt: value, date_completed_gmt: value }))
    expect(order).toMatchObject({ date_paid_gmt: null, date_completed_gmt: null })
  })

  it('still reads a real date', () => {
    expect(wooOrderSchema.parse(rawOrder({ date_completed_gmt: '2026-10-10T19:01:47' }))).toMatchObject({ date_paid_gmt: '2026-09-21T07:22:00', date_completed_gmt: '2026-10-10T19:01:47' })
  })

  it.each(['date_created_gmt', 'date_modified_gmt'])('stays strict about %s, which the feed is ordered by', (field) => {
    for (const value of ['-0001-11-30T00:00:00', '', null, '2026-09-21']) {
      expect(wooOrderSchema.safeParse(rawOrder({ [field]: value })).success).toBe(false)
    }
  })
})

describe('wooOrderSchema: what a shop may send at most', () => {
  const long = (length: number) => 'x'.repeat(length)

  it('cuts what a person reads, so a Buyer\'s endless text costs neither the order nor the page', () => {
    const order = wooOrderSchema.parse(rawOrder({ billing: { ...(rawOrder().billing as object), first_name: long(100_000), company: long(1000), phone: long(300) }, line_items: [rawLine(0, { name: long(5000) })] }))
    expect(order.billing.first_name).toHaveLength(1000)
    expect(order.billing.company).toHaveLength(1000)
    expect(order.billing.phone).toHaveLength(255)
    expect(order.line_items[0]!.name).toHaveLength(1000)
  })

  it('reads what is wrong when cut as missing: a SKU, a gateway id, a currency', () => {
    const order = wooOrderSchema.parse(rawOrder({ currency: long(256), payment_method: `cod${long(300)}`, line_items: [rawLine(0, { sku: long(256) }), rawLine(1, { sku: long(255) })] }))
    expect(order).toMatchObject({ currency: '', payment_method: '' })
    expect(order.line_items.map((line) => line.sku.length)).toEqual([0, 255])
  })

  it('reads an amount longer than any amount as none, before anything is computed with it', () => {
    const digits = '9'.repeat(5_000_000)
    const started = performance.now()
    const order = wooOrderSchema.parse(rawOrder({ total: digits, line_items: [rawLine(0, { total: digits, total_tax: `${'1'.repeat(41)}` }), rawLine(1, { total: `${'1'.repeat(37)}.00` })] }))
    expect(order.total).toBe('')
    expect(order.line_items[0]).toMatchObject({ total: '', total_tax: '' })
    // 40 characters are still an amount as far as the reader goes; the mapper decides whether it is money.
    expect(order.line_items[1]!.total).toHaveLength(40)
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('still refuses an amount that is not a string', () => {
    expect(wooOrderSchema.safeParse(rawOrder({ line_items: [rawLine(0, { total: 126.13 })] })).success).toBe(false)
  })

  it('reads an order with more lines than any order has without its lines, and does not look at them', () => {
    const lines = Array.from({ length: WOO_LINE_ITEMS_MAX + 1 }, () => ({ not: 'a line' }))
    expect(wooOrderSchema.parse(rawOrder({ line_items: lines })).line_items).toEqual([])
    const most = Array.from({ length: WOO_LINE_ITEMS_MAX }, (_, index) => rawLine(0, { id: index + 1 }))
    expect(wooOrderSchema.parse(rawOrder({ line_items: most })).line_items).toHaveLength(WOO_LINE_ITEMS_MAX)
  })

  it('refuses a status longer than a status is: the feed runs on it', () => {
    expect(wooOrderSchema.safeParse(rawOrder({ status: long(65) })).success).toBe(false)
    expect(wooOrderSchema.safeParse(rawOrder({ status: long(64) })).success).toBe(true)
    expect(wooOrderStatusSchema.safeParse({ id: 33, status: long(65) }).success).toBe(false)
  })

  it('refuses a page longer than the longest page there is, before reading its orders', () => {
    const page = (length: number) => Array.from({ length }, (_, index) => rawOrder({ id: index + 1 }))
    expect(wooOrdersSchema.parse(page(WOO_ORDERS_PER_PAGE_MAX))).toHaveLength(WOO_ORDERS_PER_PAGE_MAX)
    const tooLong = wooOrdersSchema.safeParse([...page(WOO_ORDERS_PER_PAGE_MAX), { not: 'an order' }])
    expect(tooLong.success).toBe(false)
    // The length is what is wrong, not the 101st entry.
    expect(tooLong.error?.issues.map((issue) => [issue.path.join('.'), issue.code])).toEqual([['', 'too_big']])
    expect(wooOrderIdsSchema.safeParse(Array.from({ length: WOO_ORDERS_PER_PAGE_MAX + 1 }, (_, index) => ({ id: index + 1 }))).success).toBe(false)
  })
})

describe('WOO_ORDER_FIELDS', () => {
  it('asks the shop for exactly what the order schema reads', () => {
    expect(WOO_ORDER_FIELDS).toEqual([
      'id',
      'status',
      'currency',
      'date_created_gmt',
      'date_modified_gmt',
      'date_paid_gmt',
      'date_completed_gmt',
      'total',
      'payment_method',
      'billing',
      'shipping',
      'line_items',
    ])
    // Every one of them is a key the shop really sends.
    for (const field of WOO_ORDER_FIELDS) expect(rawOrder()).toHaveProperty(field)
  })

  it('an order cut down to those fields reads the same as the whole one', () => {
    const whole = rawOrder()
    const cut = Object.fromEntries(WOO_ORDER_FIELDS.map((field) => [field, whole[field]]))
    expect(wooOrderSchema.parse(cut)).toEqual(wooOrderSchema.parse(whole))
  })
})

describe('wooOrderIdsSchema', () => {
  it('reads the ids of a list asked for with _fields=id, and an empty shop', () => {
    expect(wooOrderIdsSchema.parse([{ id: 57 }])).toEqual([{ id: 57 }])
    expect(wooOrderIdsSchema.parse([])).toEqual([])
  })

  it('refuses an answer that is not a list of orders', () => {
    expect(wooOrderIdsSchema.safeParse({ code: 'rest_no_route' }).success).toBe(false)
    expect(wooOrderIdsSchema.safeParse([{ id: 0 }]).success).toBe(false)
  })
})

describe('wooOrderStatusSchema', () => {
  it('reads the status of one order, whether the answer is cut down to it or whole', () => {
    expect(wooOrderStatusSchema.parse({ id: 33, status: 'pending' })).toEqual({ id: 33, status: 'pending' })
    expect(wooOrderStatusSchema.parse(rawOrder())).toEqual({ id: 39, status: 'processing' })
    // A status a plugin registered, and the trash.
    expect(wooOrderStatusSchema.parse({ id: 47, status: 'packing' }).status).toBe('packing')
    expect(wooOrderStatusSchema.parse({ id: 55, status: 'trash' }).status).toBe('trash')
  })

  it('refuses an answer without a status', () => {
    expect(wooOrderStatusSchema.safeParse({ id: 33 }).success).toBe(false)
    expect(wooOrderStatusSchema.safeParse({ id: 33, status: '' }).success).toBe(false)
  })
})

describe('wooProductSchema', () => {
  it('reads a simple product', () => {
    expect(wooProductSchema.parse(rawSimpleProduct())).toEqual({
      id: 10,
      name: 'Kubek ceramiczny żółty',
      type: 'simple',
      status: 'publish',
      sku: 'WOO-MUG-1',
      price: '49.99',
      permalink: 'https://shop.example.test/product/kubek-ceramiczny-zolty/',
    })
  })

  it('reads a variable product, without the ids of its variations: they are listed from their own endpoint', () => {
    const product = wooProductSchema.parse(rawVariableProduct())
    expect(product).toMatchObject({ id: 19, type: 'variable', sku: 'WOO-TSHIRT' })
    expect(product).not.toHaveProperty('variations')
  })

  it('reads a null or missing text like WooCommerce\'s empty string', () => {
    const { sku: _sku, ...withoutSku } = rawSimpleProduct({ name: null, price: null, permalink: null })
    expect(wooProductSchema.parse(withoutSku)).toMatchObject({ name: '', sku: '', price: '', permalink: '' })
  })

  it.each([
    ['no type', { type: '' }, ['type']],
    ['a type that is not text', { type: 7 }, ['type']],
    ['no status', { status: null }, ['status']],
    ['a name that is not text', { name: ['x'] }, ['name']],
    ['a price that is a number', { price: 49.99 }, ['price']],
    ['an id that is not a whole number', { id: 10.5 }, ['id']],
  ])('refuses %s', (_, overrides, paths) => {
    const result = wooProductSchema.safeParse(rawSimpleProduct(overrides))
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual(paths)
  })

  it('reads a type and a status it has never heard of', () => {
    expect(wooProductSchema.parse(rawSimpleProduct({ type: 'subscription', status: 'wc-archived' }))).toMatchObject({ type: 'subscription', status: 'wc-archived' })
  })
})

describe('wooVariationSchema', () => {
  it('reads a variation', () => {
    expect(wooVariationSchema.parse(rawVariation())).toEqual({
      id: 21,
      status: 'publish',
      sku: 'WOO-TSHIRT',
      price: '79.00',
      permalink: 'https://shop.example.test/product/koszulka-testowa/?attribute_rozmiar=M',
      attributes: [{ name: 'Rozmiar', option: 'M' }],
    })
  })

  it('reads a variation that leaves its stock to its parent (manage_stock "parent")', () => {
    expect(wooVariationSchema.safeParse(rawVariation({ id: 22, manage_stock: 'parent', stock_quantity: 40 })).success).toBe(true)
  })
})

describe('what a shop can send for a product', () => {
  const megabyte = 'x'.repeat(1024 * 1024)

  it('keeps the product and cuts a name that is longer than any', () => {
    const product = wooProductSchema.parse(rawSimpleProduct({ name: `Kubek ${megabyte}` }))
    expect(product.name).toHaveLength(WOO_NAME_MAX)
    expect(product.name.startsWith('Kubek xxx')).toBe(true)
    expect(wooProductSchema.parse(rawSimpleProduct({ name: 'n'.repeat(WOO_NAME_MAX) })).name).toHaveLength(WOO_NAME_MAX)
  })

  it('keeps the product and reads a SKU, a price or a link that is longer than any as missing: cut, each would be another value', () => {
    expect(wooProductSchema.parse(rawSimpleProduct({ sku: megabyte, price: `1${'0'.repeat(100)}.00`, permalink: `https://shop.example.test/${megabyte}` }))).toMatchObject({
      id: 10,
      name: 'Kubek ceramiczny żółty',
      sku: '',
      price: '',
      permalink: '',
    })
    // At the limits they are read as they are.
    const atLimit = { sku: 's'.repeat(255), price: '9'.repeat(32), permalink: `https://shop.example.test/${'p'.repeat(2048 - 26)}` }
    expect(atLimit.permalink).toHaveLength(2048)
    expect(wooProductSchema.parse(rawSimpleProduct(atLimit))).toMatchObject(atLimit)
    expect(wooProductSchema.parse(rawSimpleProduct({ sku: 's'.repeat(256), price: '9'.repeat(33) }))).toMatchObject({ sku: '', price: '' })
  })

  it('cuts a type or a status that is longer than any word: it then is none the connector knows', () => {
    const product = wooProductSchema.parse(rawSimpleProduct({ type: `simple${megabyte}`, status: `publish${megabyte}` }))
    expect(product.type).toHaveLength(64)
    expect(product.status).toHaveLength(64)
  })

  it('does the same for a variation, and keeps a handful of attributes with short values', () => {
    const attributes = Array.from({ length: 500 }, (_, index) => ({ id: 0, name: megabyte, slug: 'x', option: index === 0 ? megabyte : `V${index}` }))
    const variation = wooVariationSchema.parse(rawVariation({ sku: megabyte, price: megabyte, permalink: megabyte, status: megabyte, attributes }))
    expect(variation).toMatchObject({ id: 21, sku: '', price: '', permalink: '' })
    expect(variation.status).toHaveLength(64)
    expect(variation.attributes).toHaveLength(20)
    expect(variation.attributes[0]).toEqual({ name: 'x'.repeat(100), option: 'x'.repeat(100) })
    expect(variation.attributes[1]!.option).toBe('V1')
  })

  it('refuses a page with more items than can be asked for', () => {
    const products = (count: number) => Array.from({ length: count }, (_, index) => rawSimpleProduct({ id: index + 1 }))
    const variations = (count: number) => Array.from({ length: count }, (_, index) => rawVariation({ id: index + 1 }))
    expect(WOO_MAX_PER_PAGE).toBe(100)
    expect(wooProductsSchema.parse(products(100))).toHaveLength(100)
    expect(wooProductsSchema.safeParse(products(101)).error?.issues.map((issue) => issue.code)).toEqual(['too_big'])
    expect(wooVariationsSchema.parse(variations(100))).toHaveLength(100)
    expect(wooVariationsSchema.safeParse(variations(101)).success).toBe(false)
    expect(wooBatchResponseSchema.parse({ update: products(100) }).update).toHaveLength(100)
    expect(wooBatchResponseSchema.safeParse({ update: products(101) }).success).toBe(false)
  })

  it('cuts a currency code, a batch item\'s type, status and error code that are longer than any', () => {
    expect(wooCurrencySchema.parse({ code: megabyte }).code).toHaveLength(64)
    const [item, refused] = wooBatchResponseSchema.parse({ update: [rawSimpleProduct({ type: megabyte, status: megabyte }), { id: 11, error: { code: megabyte } }] }).update
    expect(item!.type).toHaveLength(64)
    expect(item!.status).toHaveLength(64)
    // Longer than a rejection code may be, so it is never passed on as one.
    expect(refused!.error!.code).toHaveLength(128)
  })
})

describe('wooProductTypesSchema', () => {
  it('reads what each product is, as the sandbox answered `GET products?include=10,13,19,27&_fields=id,type`', () => {
    const answer = [{ id: 27, type: 'grouped' }, { id: 19, type: 'variable' }, { id: 13, type: 'simple' }, { id: 10, type: 'simple' }]
    expect(wooProductTypesSchema.parse(answer)).toEqual(answer)
    expect(wooProductTypesSchema.parse([])).toEqual([])
    expect(WOO_PRODUCT_TYPE_FIELDS).toEqual(['id', 'type'])
  })

  it('reads whole products too, where a shop ignores _fields', () => {
    expect(wooProductTypesSchema.parse([rawSimpleProduct(), rawVariableProduct()])).toEqual([{ id: 10, type: 'simple' }, { id: 19, type: 'variable' }])
  })

  it('refuses a product without an id or a type, and more products than a batch holds', () => {
    expect(wooProductTypesSchema.safeParse([{ id: 10 }]).success).toBe(false)
    expect(wooProductTypesSchema.safeParse([{ type: 'simple' }]).success).toBe(false)
    expect(wooProductTypesSchema.safeParse(Array.from({ length: 101 }, (_, index) => ({ id: index + 1, type: 'simple' }))).success).toBe(false)
  })
})

describe('wooBatchResponseSchema', () => {
  // As the sandbox answered `POST products/batch` with one product it updated and one id it does not have.
  const updated = rawSimpleProduct({ manage_stock: true, stock_quantity: 5 })
  const refused = { id: 999999, error: { code: 'woocommerce_rest_product_invalid_id', message: 'Invalid ID.', data: { status: 400 } } }

  it('reads an updated item and a refused one, in the order they were sent', () => {
    expect(wooBatchResponseSchema.parse({ update: [updated, refused] })).toEqual({
      update: [
        { id: 10, type: 'simple', status: 'publish', manage_stock: true, stock_quantity: 5 },
        { id: 999999, error: { code: 'woocommerce_rest_product_invalid_id' } },
      ],
    })
  })

  it('reads the echo of a product whose stock WooCommerce does not manage', () => {
    // A grouped product: the number is not taken.
    expect(wooBatchResponseSchema.parse({ update: [rawSimpleProduct({ type: 'grouped', manage_stock: false, stock_quantity: null })] }).update).toEqual([
      { id: 10, type: 'grouped', status: 'publish', manage_stock: false, stock_quantity: null },
    ])
    // Any product while the shop's stock management is off: the sandbox answered with the number the product had.
    expect(wooBatchResponseSchema.parse({ update: [rawSimpleProduct({ manage_stock: false, stock_quantity: 5 })] }).update).toEqual([
      { id: 10, type: 'simple', status: 'publish', manage_stock: false, stock_quantity: 5 },
    ])
    expect(wooBatchResponseSchema.parse({ update: [rawVariation({ manage_stock: 'parent', stock_quantity: 40 })] }).update).toEqual([
      { id: 21, type: 'variation', status: 'publish', manage_stock: 'parent', stock_quantity: 40 },
    ])
  })

  it('reads the type of what was updated: products/batch also takes a variable product', () => {
    expect(wooBatchResponseSchema.parse({ update: [rawVariableProduct({ manage_stock: true, stock_quantity: 9 })] }).update).toEqual([
      { id: 19, type: 'variable', status: 'publish', manage_stock: true, stock_quantity: 9 },
    ])
  })

  it('reads the status of what was updated: WooCommerce updates what is in the trash too', () => {
    // As the sandbox answered for a variation whose parent is in the trash.
    expect(wooBatchResponseSchema.parse({ update: [rawVariation({ id: 25, status: 'trash', manage_stock: true, stock_quantity: 3 })] }).update).toEqual([
      { id: 25, type: 'variation', status: 'trash', manage_stock: true, stock_quantity: 3 },
    ])
  })

  it('reads an error code that is a number, which WordPress allows, as text', () => {
    expect(wooBatchResponseSchema.parse({ update: [{ id: 10, error: { code: 500, message: 'x' } }] }).update).toEqual([{ id: 10, error: { code: '500' } }])
  })

  it('refuses an item without an id: an answer could not be matched to what was sent', () => {
    expect(wooBatchResponseSchema.safeParse({ update: [{ error: { code: 'woocommerce_rest_product_invalid_id' } }] }).success).toBe(false)
  })

  it('reads an answer without updates', () => {
    expect(wooBatchResponseSchema.parse({})).toEqual({ update: [] })
  })
})

describe('WOO_PRODUCT_FIELDS and WOO_VARIATION_FIELDS', () => {
  it('ask the shop for exactly what the schemas read', () => {
    expect([...WOO_PRODUCT_FIELDS].sort()).toEqual(['id', 'name', 'permalink', 'price', 'sku', 'status', 'type'])
    expect([...WOO_VARIATION_FIELDS].sort()).toEqual(['attributes', 'id', 'permalink', 'price', 'sku', 'status'])
  })

  it('a product and a variation cut down to those fields read the same as the whole ones', () => {
    const cut = (raw: Record<string, unknown>, fields: readonly string[]) => Object.fromEntries(Object.entries(raw).filter(([key]) => fields.includes(key)))
    expect(wooProductSchema.parse(cut(rawVariableProduct(), WOO_PRODUCT_FIELDS))).toEqual(wooProductSchema.parse(rawVariableProduct()))
    expect(wooVariationSchema.parse(cut(rawVariation(), WOO_VARIATION_FIELDS))).toEqual(wooVariationSchema.parse(rawVariation()))
  })
})

describe('wooCurrencySchema', () => {
  it('reads the shop currency', () => {
    // `GET data/currencies/current` on the sandbox.
    expect(wooCurrencySchema.parse({ code: 'PLN', name: 'Polish z&#x142;oty', symbol: '&#122;&#322;', _links: {} })).toEqual({ code: 'PLN' })
  })
})
