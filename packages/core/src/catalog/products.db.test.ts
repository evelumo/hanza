import { describe, expect, it } from 'vitest'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { createTestConnection, uniqueSku, user } from '../testing/fixtures'
import { getAvailability } from '../stock/availability'
import { upsertOffers } from './offers'
import { createProduct, createProductsFromOffers, findProductBySku, getProduct, listProducts, updateProduct } from './products'

describe.skipIf(!databaseUrl)('products', () => {
  const context = useTestContext()

  it('creates a Product with its Stock row in the default Warehouse and a product.created Event', async () => {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const { productId } = await createProduct(ctx, org, { sku: '  MUG-1 ', name: 'Kubek', stock: 7 }, user)

    const product = await ctx.db.product.findFirstOrThrow({ where: { id: productId } })
    expect(product.sku).toBe('MUG-1')
    const stock = await ctx.db.stock.findMany({ where: { productId }, include: { warehouse: true } })
    expect(stock).toHaveLength(1)
    expect(stock[0]).toMatchObject({ units: 7, organizationId: org, warehouse: { code: 'default', organizationId: org } })
    const events = await ctx.db.eventLog.findMany({ where: { organizationId: org, subjectId: productId } })
    expect(events.map((event) => [event.type, event.payload])).toEqual([
      ['product.created', { sku: 'MUG-1', origin: 'manual', actor: user }],
    ])
  })

  it('refuses a duplicate SKU with sku_taken', async () => {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    await createProduct(ctx, org, { sku: 'DUP', name: 'A', stock: 0 }, user)
    await expect(createProduct(ctx, org, { sku: 'DUP', name: 'B', stock: 0 }, user)).rejects.toMatchObject({ code: 'sku_taken' })
    // The same SKU in another organization is fine.
    const other = await createTestOrganization(ctx.db)
    await expect(createProduct(ctx, other, { sku: 'DUP', name: 'C', stock: 0 }, user)).resolves.toBeDefined()
  })

  it('auto-links never-linked Offers with the same SKU and requests a stock push', async () => {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const connectionId = await createTestConnection(ctx, org)
    await upsertOffers(ctx, org, connectionId, [{ externalId: 'o1', sku: 'TSHIRT', name: 'Koszulka', url: null }], new Date())

    const { productId } = await createProduct(ctx, org, { sku: 'TSHIRT', name: 'Koszulka', stock: 3 }, user)

    const offer = await ctx.db.offer.findFirstOrThrow({ where: { organizationId: org, externalId: 'o1' } })
    expect(offer).toMatchObject({ productId, linkedBy: 'sku', stockPushSeq: 1, stockPushedSeq: 0 })
    const linked = await ctx.db.eventLog.findMany({ where: { organizationId: org, type: 'offer.linked' } })
    expect(linked.map((event) => event.payload)).toEqual([{ productId, linkedBy: 'sku', actor: user }])
    expect(ctx.queue.enqueued).toContainEqual({
      name: 'stock.push',
      payload: { organizationId: org, connectionId },
      options: { coalesceKey: `stock.push:${connectionId}` },
    })
  })

  it('creates Products from Offers and reports every skip reason', async () => {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const connectionId = await createTestConnection(ctx, org)
    await createProduct(ctx, org, { sku: 'TAKEN', name: 'Istniejący', stock: 0 }, user)
    await upsertOffers(
      ctx,
      org,
      connectionId,
      [
        { externalId: 'good', sku: 'NEW-1', name: 'Nowy produkt', url: null },
        { externalId: 'twin', sku: 'NEW-1', name: 'Ten sam SKU', url: null },
        { externalId: 'nosku', sku: null, name: 'Bez SKU', url: null },
        { externalId: 'linked', sku: 'TAKEN', name: 'Już połączona', url: null },
      ],
      new Date(),
    )
    // A second Offer whose SKU collides with an existing Product but is not linked to it.
    const takenOffer = await ctx.db.offer.create({
      data: { organizationId: org, connectionId, externalId: 'taken', sku: 'TAKEN', name: 'X', lastSeenAt: new Date(), linkedBy: 'manual' },
    })
    const offers = await ctx.db.offer.findMany({ where: { organizationId: org } })
    const id = (externalId: string) => offers.find((offer) => offer.externalId === externalId)!.id

    const result = await createProductsFromOffers(ctx, org, [id('good'), id('twin'), id('nosku'), id('linked'), takenOffer.id, 'missing'], user)

    expect(result.created).toHaveLength(1)
    expect(result.skipped).toEqual([
      { offerId: id('twin'), reason: 'sku_taken' },
      { offerId: id('nosku'), reason: 'no_sku' },
      { offerId: id('linked'), reason: 'already_linked' },
      { offerId: takenOffer.id, reason: 'sku_taken' },
      { offerId: 'missing', reason: 'not_found' },
    ])
    const product = await ctx.db.product.findFirstOrThrow({ where: { id: result.created[0] } })
    expect(product).toMatchObject({ sku: 'NEW-1', name: 'Nowy produkt' })
    // The chosen Offer and the never-linked twin both end up linked by SKU.
    const linked = await ctx.db.offer.findMany({ where: { organizationId: org, productId: product.id }, orderBy: { externalId: 'asc' } })
    expect(linked.map((offer) => [offer.externalId, offer.linkedBy, offer.stockPushSeq])).toEqual([
      ['good', 'sku', 1],
      ['twin', 'sku', 1],
    ])
    expect((await getAvailability(ctx.db, org, [product.id])).get(product.id)).toEqual({ stock: 0, reserved: 0, available: 0 })
    const created = await ctx.db.eventLog.findMany({ where: { organizationId: org, type: 'product.created', subjectId: product.id } })
    expect(created[0]?.payload).toEqual({ sku: 'NEW-1', origin: 'offer', actor: user })
  })

  it('updates the name with a product.updated Event; finds, lists and details Products', async () => {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const sku = uniqueSku('LIST')
    const { productId } = await createProduct(ctx, org, { sku, name: 'Stara nazwa', stock: 4 }, user)
    await createProduct(ctx, org, { sku: 'OTHER', name: 'Inny', stock: 0 }, user)
    await updateProduct(ctx, org, productId, { name: 'Nowa nazwa' }, user)

    const updated = await ctx.db.eventLog.findFirstOrThrow({ where: { organizationId: org, type: 'product.updated' } })
    expect(updated.payload).toEqual({ name: { from: 'Stara nazwa', to: 'Nowa nazwa' }, actor: user })
    expect(await findProductBySku(ctx, org, ` ${sku} `)).toEqual({ id: productId })
    expect(await findProductBySku(ctx, org, sku.toLowerCase())).toBeNull()

    const list = await listProducts(ctx, org, { search: 'nowa', skip: 0, take: 10 })
    expect(list).toEqual({
      total: 1,
      items: [{ id: productId, sku, name: 'Nowa nazwa', stock: 4, reserved: 0, available: 4, linkedOffers: 0 }],
    })
    expect((await listProducts(ctx, org, { skip: 0, take: 10 })).total).toBe(2)

    const detail = await getProduct(ctx, org, productId)
    expect(detail).toMatchObject({ id: productId, stock: 4, available: 4, offers: [], openReservations: [] })
  })
})
