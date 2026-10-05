import { describe, expect, it } from 'vitest'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { createTestConnection, user } from '../testing/fixtures'
import { setStock } from '../stock/set-stock'
import { linkOffer, listOffers, listOffersAwaitingStockPush, markOffersPushed, unlinkOffer, upsertOffers } from './offers'
import { createProduct } from './products'

describe.skipIf(!databaseUrl)('offers', () => {
  const context = useTestContext()

  async function setup() {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const connectionId = await createTestConnection(ctx, org)
    const a = (await createProduct(ctx, org, { sku: 'A', name: 'A', stock: 1 }, user)).productId
    const b = (await createProduct(ctx, org, { sku: 'B', name: 'B', stock: 1 }, user)).productId
    const offer = (externalId: string) => ctx.db.offer.findFirstOrThrow({ where: { organizationId: org, connectionId, externalId } })
    return { ctx, org, connectionId, a, b, offer }
  }

  it('links never-linked Offers by SKU, lets SKU-linked ones follow their SKU and leaves manual links alone', async () => {
    const { ctx, org, connectionId, a, b, offer } = await setup()
    const first = await upsertOffers(
      ctx,
      org,
      connectionId,
      [
        { externalId: 'null-to-sku', sku: ' A ', name: 'Linked by SKU', url: 'https://example.com/1' },
        { externalId: 'no-match', sku: 'NOPE', name: 'No Product', url: null },
        { externalId: 'relink', sku: 'A', name: 'Will change SKU', url: null },
        { externalId: 'unlink', sku: 'B', name: 'Will lose SKU', url: null },
        { externalId: 'manual', sku: 'A', name: 'Manual', url: null },
      ],
      new Date('2026-10-01T10:00:00Z'),
    )
    expect(first).toEqual({ created: 5, updated: 0, linked: 4, repriced: 0 })
    expect(await offer('null-to-sku')).toMatchObject({ sku: 'A', productId: a, linkedBy: 'sku', stockPushSeq: 1 })
    expect(await offer('no-match')).toMatchObject({ productId: null, linkedBy: null, stockPushSeq: 0 })

    await unlinkOffer(ctx, org, (await offer('manual')).id, user)
    const seenAt = new Date('2026-10-01T11:00:00Z')
    const second = await upsertOffers(
      ctx,
      org,
      connectionId,
      [
        { externalId: 'relink', sku: 'B', name: 'Changed SKU', url: null },
        { externalId: 'unlink', sku: 'GONE', name: 'Lost SKU', url: null },
        { externalId: 'manual', sku: 'A', name: 'Manual', url: null },
        { externalId: 'null-to-sku', sku: 'A', name: 'Renamed', url: null },
      ],
      seenAt,
    )
    expect(second).toEqual({ created: 0, updated: 4, linked: 1, repriced: 1 })
    expect(await offer('relink')).toMatchObject({ productId: b, linkedBy: 'sku', stockPushSeq: 2 })
    expect(await offer('unlink')).toMatchObject({ productId: null, linkedBy: null, sku: 'GONE' })
    expect(await offer('manual')).toMatchObject({ productId: null, linkedBy: 'manual' })
    expect(await offer('null-to-sku')).toMatchObject({ productId: a, name: 'Renamed', url: null, lastSeenAt: seenAt, stockPushSeq: 1 })

    // A Product created later links the never-linked Offer, but not the one unlinked by hand.
    const nope = (await createProduct(ctx, org, { sku: 'NOPE', name: 'Nope', stock: 0 }, user)).productId
    expect(await offer('no-match')).toMatchObject({ productId: nope, linkedBy: 'sku' })
    const unlinked = await ctx.db.eventLog.findMany({ where: { organizationId: org, type: 'offer.unlinked' }, orderBy: { id: 'asc' } })
    expect(unlinked.map((event) => event.payload)).toEqual([
      { productId: a, linkedBy: 'manual', actor: user },
      { productId: a, linkedBy: 'sku', actor: { type: 'system' } },
      { productId: b, linkedBy: null, actor: { type: 'system' } },
    ])
  })

  it('links and unlinks by hand; manual links survive later pulls', async () => {
    const { ctx, org, connectionId, b, offer } = await setup()
    await upsertOffers(ctx, org, connectionId, [{ externalId: 'x', sku: 'A', name: 'X', url: null }], new Date())
    const { id } = await offer('x')
    ctx.queue.waiting.length = 0

    await linkOffer(ctx, org, id, b, user)
    expect(await offer('x')).toMatchObject({ productId: b, linkedBy: 'manual', stockPushSeq: 2 })
    expect(ctx.queue.waiting.map((job) => job.name)).toEqual(['stock.push', 'price.push'])

    await upsertOffers(ctx, org, connectionId, [{ externalId: 'x', sku: 'A', name: 'X', url: null }], new Date())
    expect(await offer('x')).toMatchObject({ productId: b, linkedBy: 'manual' })

    ctx.queue.waiting.length = 0
    await unlinkOffer(ctx, org, id, user)
    expect(await offer('x')).toMatchObject({ productId: null, linkedBy: 'manual' })
    expect(ctx.queue.waiting).toEqual([])

    const unlinkedOnly = await listOffers(ctx, org, { linked: false, skip: 0, take: 10 })
    expect(unlinkedOnly.items.map((row) => row.externalId)).toEqual(['x'])
    expect(unlinkedOnly.items[0]).toMatchObject({ connectionName: 'Test channel', productSku: null, linkedBy: 'manual' })
    expect((await listOffers(ctx, org, { linked: true, skip: 0, take: 10 })).total).toBe(0)
  })

  it('lists Offers awaiting a push and clears them compare-and-set', async () => {
    const { ctx, org, connectionId, a, offer } = await setup()
    await upsertOffers(
      ctx,
      org,
      connectionId,
      [
        { externalId: 'p1', sku: 'A', name: 'P1', url: null },
        { externalId: 'p2', sku: 'B', name: 'P2', url: null },
        { externalId: 'p3', sku: null, name: 'Unlinked', url: null },
      ],
      new Date(),
    )
    const awaiting = await listOffersAwaitingStockPush(ctx, org, connectionId, 100)
    expect(awaiting.map((row) => [row.externalId, row.seq])).toEqual([
      ['p1', 1],
      ['p2', 1],
    ])
    expect(awaiting[0]).toMatchObject({ sku: 'A', productId: a })

    // Available of A changes between listing and marking: p1 must stay pending.
    await setStock(ctx, org, a, 9, user)
    await markOffersPushed(ctx, org, awaiting.map((row) => ({ offerId: row.offerId, seq: row.seq, available: 1 })))

    const after = await listOffersAwaitingStockPush(ctx, org, connectionId, 100)
    expect(after.map((row) => [row.externalId, row.seq])).toEqual([['p1', 2]])
    expect(await offer('p2')).toMatchObject({ stockPushedSeq: 1, lastPushedAvailable: 1 })
    expect((await offer('p2')).lastPushedAt).toBeInstanceOf(Date)
    expect(await offer('p1')).toMatchObject({ stockPushedSeq: 1, stockPushSeq: 2 })

    // An older seq never moves the marker backwards.
    await markOffersPushed(ctx, org, [{ offerId: after[0]!.offerId, seq: 2, available: 9 }])
    await markOffersPushed(ctx, org, [{ offerId: after[0]!.offerId, seq: 1, available: 1 }])
    expect(await offer('p1')).toMatchObject({ stockPushedSeq: 2, lastPushedAvailable: 9 })
    expect(await listOffersAwaitingStockPush(ctx, org, connectionId, 100)).toEqual([])
  })
})
