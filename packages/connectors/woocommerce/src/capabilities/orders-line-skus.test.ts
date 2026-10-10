import { describe, expect, it } from 'vitest'
import { wooOrderSchema, type WooOrder } from '../api'
import { rawLine, rawOrder } from '../testing/samples'
import { FakeShop } from '../testing/orders-fake-shop'
import { readParentSkus, withOwnSkus } from './orders-line-skus'

// The sandbox's order 39: line 0 is variation 20 of product 19 with its own SKU, line 1 variation 21 with the
// parent's (`WOO-TSHIRT`), line 2 a simple product, line 3 a product without a SKU.
const order = (overrides: Record<string, unknown> = {}): WooOrder => wooOrderSchema.parse(rawOrder(overrides))
const skus = (mapped: WooOrder) => mapped.line_items.map((line) => line.sku)

describe('withOwnSkus', () => {
  it('removes the SKU a variation inherited from its parent, and keeps every other', () => {
    expect(skus(withOwnSkus(order(), new Map([[19, 'WOO-TSHIRT']])))).toEqual(['WOO-TSHIRT-S', '', 'WOO-MUG-1', ''])
  })

  it('keeps a variation\'s SKU when its parent has none', () => {
    expect(skus(withOwnSkus(order(), new Map([[19, '']])))).toEqual(['WOO-TSHIRT-S', 'WOO-TSHIRT', 'WOO-MUG-1', ''])
  })

  it('removes the SKU of every variation line whose parent is unknown, and never a simple product\'s', () => {
    expect(skus(withOwnSkus(order(), new Map()))).toEqual(['', '', 'WOO-MUG-1', ''])
    // A simple product that happens to be in the map with the same SKU is not a parent of its own line.
    expect(skus(withOwnSkus(order(), new Map([[10, 'WOO-MUG-1']])))).toEqual(['', '', 'WOO-MUG-1', ''])
  })

  it('compares without the spaces around a SKU', () => {
    const spaced = order({ line_items: [rawLine(1, { sku: ' WOO-TSHIRT ' })] })
    expect(skus(withOwnSkus(spaced, new Map([[19, 'WOO-TSHIRT']])))).toEqual([''])
  })

  it('leaves a deleted product\'s line and the rest of the order as they are', () => {
    const gone = order({ line_items: [rawLine(0, { product_id: 0, variation_id: 0, sku: null })] })
    expect(withOwnSkus(gone, new Map())).toEqual(gone)
    const whole = order()
    const { line_items: _lines, ...rest } = withOwnSkus(whole, new Map())
    expect(rest).toEqual({ ...whole, line_items: undefined })
    // The snapshot it was given is not changed.
    expect(skus(whole)).toEqual(['WOO-TSHIRT-S', 'WOO-TSHIRT', 'WOO-MUG-1', ''])
  })
})

describe('readParentSkus', () => {
  it('asks for the parents of variation lines that have a SKU, each once, lowest id first', async () => {
    const shop = new FakeShop().product(19, 'WOO-TSHIRT').product(24, '')
    const hoodie = order({ id: 41, line_items: [rawLine(1, { id: 90, product_id: 24, variation_id: 25, sku: 'WOO-HOODIE-BLK-M' }), rawLine(1, { id: 91, product_id: 24, variation_id: 26, sku: '' })] })
    expect(await readParentSkus(shop.context(), [hoodie, order(), order({ id: 40 })])).toEqual(
      new Map([
        [19, 'WOO-TSHIRT'],
        [24, ''],
      ]),
    )
    expect(shop.urls).toEqual(['GET products?include=19,24&per_page=100&_fields=id,sku'])
  })

  it('asks nothing when there is nothing to ask', async () => {
    const shop = new FakeShop()
    expect(await readParentSkus(shop.context(), [])).toEqual(new Map())
    expect(await readParentSkus(shop.context(), [order({ line_items: [rawLine(2), rawLine(3)] })])).toEqual(new Map())
    expect(shop.requests).toEqual([])
  })

  it('leaves out a parent the shop no longer has', async () => {
    const shop = new FakeShop()
    expect(await readParentSkus(shop.context(), [order()])).toEqual(new Map())
    expect(shop.logs).toEqual([])
  })

  it('knows nothing when the shop refuses for good, and says so once, without the SKUs', async () => {
    const shop = new FakeShop().product(19, 'WOO-TSHIRT')
    shop.productsStatus = 403
    expect(await readParentSkus(shop.context(), [order()])).toEqual(new Map())
    expect(shop.logs).toHaveLength(1)
    expect(JSON.stringify(shop.logs)).not.toContain('WOO-TSHIRT')
  })
})
