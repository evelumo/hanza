import { createDb, type Db } from '@hanza/db'
import { describe, expect, it } from 'vitest'
import { importOrder } from '../orders/import'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { buildOrder, createTestConnection, orderLine, user } from '../testing/fixtures'
import { ensureDefaultWarehouse } from '../stock/warehouse'
import { countLockWaits, uniqueApplicationName } from '../testing/lock-waits'
import { TX_OPTIONS } from '../transaction'
import { addProductToFamily, createFamily, deleteFamily, removeProductFromFamily, updateFamilyMember } from './families'
import { createProduct } from './products'

// A family operation must never take a stronger lock on a Product row than "no key update". A Product's key columns
// are the ones in a non-partial unique index, so the (familyId, attributeKey) index is partial: otherwise every family
// update would conflict with the FOR KEY SHARE that inserting an Order line, Reservation, Stock or Offer takes through
// its foreign key to the Product, and could deadlock an Order import (lines are inserted in the Channel's order).

const applicationName = uniqueApplicationName('hanza-families-locking')

describe.skipIf(!databaseUrl)('product families never block or deadlock with what references a Product', () => {
  const context = useTestContext({ applicationName })

  async function setup(members = 2) {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const family = (await createFamily(ctx, org, { name: 'Shirt', attributes: ['Size'] }, user)).familyId
    const products: Array<{ id: string; sku: string }> = []
    for (let index = 1; index <= members; index++) {
      const sku = `P${index}`
      const id = (await createProduct(ctx, org, { sku, name: sku, stock: 100 }, user)).productId
      await addProductToFamily(ctx, org, family, id, { Size: `size ${index}` }, user)
      products.push({ id, sku })
    }
    return { ctx, org, family, products }
  }

  /** Holds `FOR KEY SHARE` on the Product row, the lock a foreign-key check takes, until `release()`. */
  async function holdKeyShare(org: string, productId: string) {
    const holder: Db = createDb(databaseUrl!)
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let locked!: () => void
    const isLocked = new Promise<void>((resolve) => (locked = resolve))
    const transaction = holder.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "product" WHERE "organizationId" = ${org} AND "id" = ${productId} FOR KEY SHARE`
      locked()
      await released
    }, TX_OPTIONS)
    await isLocked
    return {
      async done() {
        release()
        await transaction
        await holder.$disconnect()
      },
    }
  }

  /** Runs `operation` while another transaction holds the FK-style lock; it must finish without waiting for it. */
  async function finishesWhileKeyShareHeld(org: string, productId: string, operation: () => Promise<unknown>) {
    const hold = await holdKeyShare(org, productId)
    try {
      const outcome = await Promise.race([
        operation().then(() => 'done'),
        new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 3_000)),
      ])
      expect(outcome).toBe('done')
      expect(await countLockWaits(context().db, applicationName)).toBe(0)
    } finally {
      await hold.done()
    }
  }

  it('(a) editing, removing and deleting a family finish while a Product row is held FOR KEY SHARE', async () => {
    const { ctx, org, family, products } = await setup()
    const [p1, p2] = [products[0]!, products[1]!]

    await finishesWhileKeyShareHeld(org, p1.id, () => updateFamilyMember(ctx, org, p1.id, { Size: 'edited' }, user))
    await finishesWhileKeyShareHeld(org, p1.id, () => removeProductFromFamily(ctx, org, p1.id, user))
    await finishesWhileKeyShareHeld(org, p2.id, () => deleteFamily(ctx, org, family, user))
    expect(await ctx.db.product.count({ where: { organizationId: org, familyId: null } })).toBe(2)
  })

  it('(a) joining a family does not wait for a held FOR KEY SHARE either', async () => {
    const { ctx, org, family } = await setup(1)
    const loose = (await createProduct(ctx, org, { sku: 'LOOSE', name: 'Loose', stock: 1 }, user)).productId
    await finishesWhileKeyShareHeld(org, loose, () => addProductToFamily(ctx, org, family, loose, { Size: 'new' }, user))
    expect(await ctx.db.product.count({ where: { organizationId: org, familyId: family } })).toBe(2)
  })

  it('(b) an Order import with its lines in reverse scan order and a concurrent delete of a big family never deadlock', async () => {
    const { ctx, org } = await setup(0)
    const connectionId = await createTestConnection(ctx, org)
    const warehouseId = await ensureDefaultWarehouse(ctx.db, org)
    const members = 1_500
    const rounds = 8

    for (let round = 0; round < rounds; round++) {
      const family = (await createFamily(ctx, org, { name: `Round ${round}`, attributes: ['Size'] }, user)).familyId
      const sku = (index: number) => `R${round}-${String(index).padStart(4, '0')}`
      await ctx.db.product.createMany({
        data: Array.from({ length: members }, (_, index) => ({
          organizationId: org,
          sku: sku(index),
          name: sku(index),
          familyId: family,
          attributeValues: { Size: String(index) },
          attributeKey: JSON.stringify([String(index)]),
        })),
      })
      // deleteFamily updates the members in scan order, the import inserts its lines (and so takes the key-share lock of
      // their foreign keys) in the Channel's order: last member first. A long update widens the window to the whole delete.
      const ends = await ctx.db.product.findMany({ where: { organizationId: org, sku: { in: [sku(0), sku(members - 1)] } }, select: { id: true } })
      await ctx.db.stock.createMany({ data: ends.map((product) => ({ organizationId: org, productId: product.id, warehouseId, units: 10 })) })
      const order = buildOrder({ lines: [orderLine('l1', { sku: sku(members - 1) }), orderLine('l2', { sku: sku(0) })] })

      const deleting = deleteFamily(ctx, org, family, user)
      await new Promise((resolve) => setTimeout(resolve, round % 4))
      const settled = await Promise.allSettled([importOrder(ctx, org, connectionId, order), deleting])

      expect(settled.map((result) => (result.status === 'rejected' ? String(result.reason) : 'ok')), `round ${round}`).toEqual(['ok', 'ok'])
    }
    expect(await ctx.db.order.count({ where: { organizationId: org } })).toBe(rounds)
    expect(await ctx.db.reservation.count({ where: { organizationId: org } })).toBe(rounds * 2)
    expect(await ctx.db.product.count({ where: { organizationId: org, familyId: { not: null } } })).toBe(0)
  })

  it('(c) a duplicate combination is still the domain error, sequentially and under concurrency', async () => {
    const { ctx, org, family } = await setup(1)
    const extra = await Promise.all(['X1', 'X2', 'X3'].map(async (sku) => (await createProduct(ctx, org, { sku, name: sku, stock: 0 }, user)).productId))

    await expect(addProductToFamily(ctx, org, family, extra[0]!, { Size: ' SIZE 1 ' }, user)).rejects.toMatchObject({ code: 'combination_taken' })

    const settled = await Promise.allSettled(extra.map((id) => addProductToFamily(ctx, org, family, id, { Size: 'Shared' }, user)))
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    for (const failure of settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected')) {
      expect(failure.reason).toMatchObject({ code: 'combination_taken' })
    }
  })
})
