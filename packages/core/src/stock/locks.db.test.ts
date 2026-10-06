import { describe, expect, it } from 'vitest'
import { createProduct } from '../catalog/products'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { uniqueSku, user } from '../testing/fixtures'
import { lockOrder, lockStock } from './locks'

describe.skipIf(!databaseUrl)('Stock and Order locks', () => {
  const context = useTestContext()

  it('refuse the database client: outside a transaction a row lock would be released at once', async () => {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const { productId } = await createProduct(ctx, org, { sku: uniqueSku(), name: 'Mug', stock: 1 }, user)

    await expect(lockStock(ctx.db, org, [productId])).rejects.toThrow('need a transaction client')
    await expect(lockOrder(ctx.db, org, 'any-order')).rejects.toThrow('need a transaction client')

    const locked = await ctx.db.$transaction(async (tx) => {
      expect(await lockOrder(tx, org, 'no-such-order')).toBe(false)
      return lockStock(tx, org, [productId])
    })
    expect(locked).toEqual([expect.objectContaining({ active: true })])
  })

  it('remember the Warehouses per transaction, never across transactions', async () => {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const { productId } = await createProduct(ctx, org, { sku: uniqueSku(), name: 'Mug', stock: 1 }, user)
    const first = await ctx.db.$transaction((tx) => lockStock(tx, org, [productId]))
    await ctx.db.warehouse.create({ data: { id: `w-${org}`, organizationId: org, code: `w-${org}`, name: 'Later' } })
    const second = await ctx.db.$transaction((tx) => lockStock(tx, org, [productId]))
    expect(first).toHaveLength(1)
    expect(second.map((warehouse) => warehouse.id)).toContain(`w-${org}`)
  })
})
