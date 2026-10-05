import { describe, expect, it } from 'vitest'
import { upsertOffers } from '../catalog/offers'
import { createProduct } from '../catalog/products'
import { DomainError } from '../errors'
import { getChannelAvailability } from '../stock/channel-available'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { createTestConnection, uniqueSku, user } from '../testing/fixtures'
import { getConnection } from './connections'
import { updateChannelStockRules } from './stock-rules'

describe.skipIf(!databaseUrl)('Channel stock rules', () => {
  const context = useTestContext()

  async function setup() {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const marketplace = await createTestConnection(ctx, org, 'Marketplace')
    const shop = await createTestConnection(ctx, org, 'Shop')
    const sku = uniqueSku()
    const { productId } = await createProduct(ctx, org, { sku, name: 'Mug', stock: 10 }, user)
    for (const connectionId of [marketplace, shop]) {
      await upsertOffers(
        ctx,
        org,
        connectionId,
        [
          { externalId: 'linked', sku, name: 'Mug', url: null },
          { externalId: 'unlinked', sku: null, name: 'Other', url: null },
        ],
        new Date(),
      )
    }
    ctx.queue.waiting.length = 0
    return { ctx, org, marketplace, shop, productId }
  }

  const seqs = async (ctx: ReturnType<typeof context>, connectionId: string) =>
    (await ctx.db.offer.findMany({ where: { connectionId }, orderBy: { externalId: 'asc' } })).map((offer) => [offer.externalId, offer.stockPushSeq])

  it('new Connections have no buffer and no limit', async () => {
    const { ctx, org, marketplace, productId } = await setup()
    expect((await getConnection(ctx, org, marketplace))?.stockRules).toEqual({ safetyBuffer: 0, channelLimit: null })
    expect(await getChannelAvailability(ctx.db, org, marketplace, [productId])).toEqual(new Map([[productId, 10]]))
  })

  it('stores the rules, writes an Event, marks only that Connection\'s linked Offers and requests its push', async () => {
    const { ctx, org, marketplace, shop, productId } = await setup()
    const shopBefore = await seqs(ctx, shop)

    await updateChannelStockRules(ctx, org, marketplace, { safetyBuffer: 3, channelLimit: 5 }, user)

    expect((await getConnection(ctx, org, marketplace))?.stockRules).toEqual({ safetyBuffer: 3, channelLimit: 5 })
    expect(await seqs(ctx, marketplace)).toEqual([['linked', 2], ['unlinked', 0]])
    expect(await seqs(ctx, shop)).toEqual(shopBefore)
    expect(ctx.queue.waiting.map((job) => [job.name, job.payload])).toEqual([['stock.push', { organizationId: org, connectionId: marketplace }]])
    const event = await ctx.db.eventLog.findFirstOrThrow({ where: { organizationId: org, type: 'connection.stock_rules_changed' } })
    expect(event).toMatchObject({
      subjectType: 'connection',
      subjectId: marketplace,
      payload: { from: { safetyBuffer: 0, channelLimit: null }, to: { safetyBuffer: 3, channelLimit: 5 }, actor: user },
    })

    expect(await getChannelAvailability(ctx.db, org, marketplace, [productId])).toEqual(new Map([[productId, 5]]))
    expect(await getChannelAvailability(ctx.db, org, shop, [productId])).toEqual(new Map([[productId, 10]]))
  })

  it('saving the same values changes nothing and pushes nothing', async () => {
    const { ctx, org, marketplace } = await setup()
    await updateChannelStockRules(ctx, org, marketplace, { safetyBuffer: 1, channelLimit: null }, user)
    ctx.queue.waiting.length = 0
    const before = await seqs(ctx, marketplace)

    await updateChannelStockRules(ctx, org, marketplace, { safetyBuffer: 1, channelLimit: null }, user)

    expect(await seqs(ctx, marketplace)).toEqual(before)
    expect(ctx.queue.waiting).toEqual([])
    expect(await ctx.db.eventLog.count({ where: { organizationId: org, type: 'connection.stock_rules_changed' } })).toBe(1)
  })

  it('rejects invalid values before touching the database, and the database rejects them too', async () => {
    const { ctx, org, marketplace } = await setup()
    await expect(updateChannelStockRules(ctx, org, marketplace, { safetyBuffer: -1, channelLimit: null }, user)).rejects.toThrow(RangeError)
    await expect(updateChannelStockRules(ctx, org, marketplace, { safetyBuffer: 0, channelLimit: -1 }, user)).rejects.toThrow(RangeError)
    await expect(updateChannelStockRules(ctx, org, marketplace, { safetyBuffer: 0.5, channelLimit: null }, user)).rejects.toThrow(RangeError)
    await expect(ctx.db.connection.update({ where: { id: marketplace }, data: { safetyBuffer: -1 } })).rejects.toThrow()
    await expect(ctx.db.connection.update({ where: { id: marketplace }, data: { channelLimit: -1 } })).rejects.toThrow()
    expect((await getConnection(ctx, org, marketplace))?.stockRules).toEqual({ safetyBuffer: 0, channelLimit: null })
  })

  it('another organization\'s Connection is not found and stays unchanged', async () => {
    const { ctx, org, marketplace, productId } = await setup()
    const other = await createTestOrganization(ctx.db)

    const attempt = updateChannelStockRules(ctx, other, marketplace, { safetyBuffer: 9, channelLimit: 0 }, user)
    await expect(attempt).rejects.toBeInstanceOf(DomainError)
    await expect(attempt).rejects.toMatchObject({ code: 'not_found' })
    expect((await getConnection(ctx, org, marketplace))?.stockRules).toEqual({ safetyBuffer: 0, channelLimit: null })
    expect(ctx.queue.waiting).toEqual([])
    // Reading through another organization sees nothing either.
    expect(await getChannelAvailability(ctx.db, other, marketplace, [productId])).toEqual(new Map())
  })
})
