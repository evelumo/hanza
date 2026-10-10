import type { Address, OrderUpdate } from '@hanza/connector-sdk'
import { describe, expect, it } from 'vitest'
import { createProduct } from '../catalog/products'
import { getAvailability } from '../stock/availability'
import { createTestOrganization } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { buildOrder, createTestConnection, fact, orderLine, testChannel, user } from '../testing/fixtures'
import { changeOrderStatus } from './change-status'
import { importOrder } from './import'
import { getOrder } from './queries'
import { applyOrderUpdate } from './update'

const delivery: Address = {
  name: 'Jane Delivery',
  company: null,
  street: '77 Revealed Street',
  postalCode: '30-001',
  city: 'Krakow',
  countryCode: 'CZ',
  phone: '+48 600 000 000',
  taxId: null,
}
const invoice: Address = { ...delivery, company: 'Delivery Ltd', street: '1 Invoice Square', taxId: 'PL1234567890' }

const update = (externalId: string, change: Partial<OrderUpdate> = {}): OrderUpdate => ({ kind: 'update', externalId, facts: [], ...change })

describe.skipIf(!databaseUrl)('applyOrderUpdate', () => {
  const context = useTestContext({ connectors: [testChannel] })

  async function setup() {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const connectionId = await createTestConnection(ctx, org)
    const { productId } = await createProduct(ctx, org, { sku: 'P', name: 'Product', stock: 10 }, user)
    const available = async () => (await getAvailability(ctx.db, org, [productId])).get(productId)!
    const events = async (orderId: string) =>
      (await ctx.db.eventLog.findMany({ where: { organizationId: org, subjectId: orderId }, orderBy: { id: 'asc' } })).map((event) => event.type)
    const imported = async (overrides: Parameters<typeof buildOrder>[0] = {}) => {
      const order = buildOrder({ lines: [orderLine('l1', { sku: 'P', quantity: 2 })], ...overrides })
      const { orderId } = await importOrder(ctx, org, connectionId, order)
      return { order, orderId }
    }
    return { ctx, org, connectionId, available, events, imported }
  }

  it('ignores an update for an Order it does not have, creating nothing', async () => {
    const { ctx, org, connectionId } = await setup()
    const before = await ctx.db.eventLog.count({ where: { organizationId: org } })
    expect(await applyOrderUpdate(ctx, org, connectionId, update('closed-before', { facts: [fact('x', 'cancelled')], shippingAddress: delivery }))).toEqual({
      found: false,
    })
    expect(await ctx.db.order.count({ where: { organizationId: org } })).toBe(0)
    expect(await ctx.db.orderChannelFact.count({ where: { organizationId: org } })).toBe(0)
    expect(await ctx.db.eventLog.count({ where: { organizationId: org } })).toBe(before)
  })

  it('pays an unpaid Order and replaces its addresses inside the sealed Buyer data, once', async () => {
    const { ctx, org, connectionId, available, events, imported } = await setup()
    const { order, orderId } = await imported({ awaitingPayment: true })
    const paid = update(order.externalId, { facts: [fact(`${order.externalId}:paid`, 'paid')], shippingAddress: delivery, billingAddress: invoice })

    expect(await applyOrderUpdate(ctx, org, connectionId, paid)).toEqual({ found: true, orderId, factsApplied: 1, addresses: 'replaced' })

    const detail = await getOrder(ctx, org, orderId)
    expect(detail).toMatchObject({ phase: 'new', awaitingPayment: false, shippingAddress: delivery, billingAddress: invoice, buyer: order.buyer })
    expect(detail?.shippingCountryCode).toBe('CZ')
    expect(await available()).toEqual({ stock: 10, reserved: 2, available: 8 })
    expect(await events(orderId)).toEqual([
      'order.imported',
      'order.channel_fact_recorded',
      'order.payment_received',
      'order.addresses_updated',
    ])
    const changed = await ctx.db.eventLog.findFirstOrThrow({ where: { subjectId: orderId, type: 'order.addresses_updated' } })
    expect(changed.payload).toEqual({ shippingAddress: true, billingAddress: true })

    // Sealed: no plaintext column, Event payload or fact holds the new address.
    const row = await ctx.db.order.findFirstOrThrow({ where: { id: orderId } })
    expect(row).toMatchObject({ buyerName: null, shippingAddress: null, billingAddress: null })
    const everything = JSON.stringify([row, await ctx.db.eventLog.findMany({ where: { organizationId: org } })])
    for (const secret of ['Revealed', 'Invoice Square', 'PL1234567890', 'Jane Delivery']) expect(everything).not.toContain(secret)

    // The same update again (a re-pulled page) changes nothing.
    expect(await applyOrderUpdate(ctx, org, connectionId, paid)).toEqual({ found: true, orderId, factsApplied: 0, addresses: 'unchanged' })
    expect(await events(orderId)).toHaveLength(4)
  })

  it('replaces only the address it carries; billingAddress null clears the billing address', async () => {
    const { ctx, org, connectionId, imported } = await setup()
    const { order, orderId } = await imported({ billingAddress: invoice })
    expect(await applyOrderUpdate(ctx, org, connectionId, update(order.externalId, { billingAddress: null }))).toMatchObject({ addresses: 'replaced' })
    expect(await getOrder(ctx, org, orderId)).toMatchObject({ shippingAddress: order.shippingAddress, billingAddress: null })
    const changed = await ctx.db.eventLog.findFirstOrThrow({ where: { subjectId: orderId, type: 'order.addresses_updated' } })
    expect(changed.payload).toEqual({ shippingAddress: false, billingAddress: true })
  })

  it('keeps the addresses of an Order past phase new, but still applies its facts', async () => {
    const { ctx, org, connectionId, events, imported } = await setup()
    const { order, orderId } = await imported()
    await changeOrderStatus(ctx, org, orderId, 'processing', user)
    const shipped = update(order.externalId, { facts: [fact(`${order.externalId}:shipped`, 'shipped')], shippingAddress: delivery })

    expect(await applyOrderUpdate(ctx, org, connectionId, shipped)).toEqual({ found: true, orderId, factsApplied: 1, addresses: 'not_new' })
    expect(await getOrder(ctx, org, orderId)).toMatchObject({ phase: 'shipped', shippingAddress: order.shippingAddress })
    expect(await events(orderId)).not.toContain('order.addresses_updated')
  })

  it('replaces the Delivery of an Order in phase new, sealed, with an Event that says only that it changed', async () => {
    const { ctx, org, connectionId, events, imported } = await setup()
    const { order, orderId } = await imported({ delivery: { method: 'Courier', pickupPoint: null } })
    const locker = { method: 'Paczkomat InPost', pickupPoint: { id: 'KRA010', name: 'Kraków, Długa 5' } }

    expect(await applyOrderUpdate(ctx, org, connectionId, update(order.externalId, { delivery: locker }))).toMatchObject({ addresses: 'replaced' })

    expect(await getOrder(ctx, org, orderId)).toMatchObject({ delivery: locker, shippingAddress: order.shippingAddress, buyer: order.buyer })
    expect(await events(orderId)).toEqual(['order.imported', 'order.delivery_updated'])
    const changed = await ctx.db.eventLog.findFirstOrThrow({ where: { subjectId: orderId, type: 'order.delivery_updated' } })
    expect(changed.payload).toEqual({ pickupPoint: true })
    const row = await ctx.db.order.findFirstOrThrow({ where: { id: orderId } })
    const everything = JSON.stringify([row, await ctx.db.eventLog.findMany({ where: { organizationId: org } })])
    for (const personal of ['KRA010', 'Paczkomat', 'Długa 5']) expect(everything).not.toContain(personal)

    // The same Delivery again writes nothing; another method for the same point says the point stayed.
    expect(await applyOrderUpdate(ctx, org, connectionId, update(order.externalId, { delivery: locker }))).toMatchObject({ addresses: 'unchanged' })
    const renamed = { ...locker, method: 'InPost locker' }
    expect(await applyOrderUpdate(ctx, org, connectionId, update(order.externalId, { delivery: renamed }))).toMatchObject({ addresses: 'replaced' })
    const last = await ctx.db.eventLog.findMany({ where: { subjectId: orderId, type: 'order.delivery_updated' }, orderBy: { id: 'asc' } })
    expect(last.map((event) => event.payload)).toEqual([{ pickupPoint: true }, { pickupPoint: false }])
  })

  it('an address update keeps the stored Delivery, and a Delivery update the addresses', async () => {
    const { ctx, org, connectionId, events, imported } = await setup()
    const locker = { method: 'Paczkomat InPost', pickupPoint: { id: 'KRA010', name: null } }
    const { order, orderId } = await imported({ delivery: locker })

    expect(await applyOrderUpdate(ctx, org, connectionId, update(order.externalId, { shippingAddress: delivery }))).toMatchObject({ addresses: 'replaced' })
    expect(await getOrder(ctx, org, orderId)).toMatchObject({ delivery: locker, shippingAddress: delivery })
    expect(await events(orderId)).toEqual(['order.imported', 'order.addresses_updated'])
  })

  it('keeps the Delivery of an Order past phase new', async () => {
    const { ctx, org, connectionId, events, imported } = await setup()
    const locker = { method: 'Paczkomat InPost', pickupPoint: { id: 'KRA010', name: null } }
    const { order, orderId } = await imported({ delivery: locker })
    await changeOrderStatus(ctx, org, orderId, 'processing', user)
    const other = { method: 'Paczkomat InPost', pickupPoint: { id: 'WAW999', name: null } }

    expect(await applyOrderUpdate(ctx, org, connectionId, update(order.externalId, { delivery: other }))).toMatchObject({ addresses: 'not_new' })
    expect(await getOrder(ctx, org, orderId)).toMatchObject({ delivery: locker })
    expect(await events(orderId)).not.toContain('order.delivery_updated')
  })

  it('a cancelled fact releases the Reservation, as for a full Order', async () => {
    const { ctx, org, connectionId, available, imported } = await setup()
    const { order, orderId } = await imported({ awaitingPayment: true })
    const removed = { ...fact(`${order.externalId}:removed`, 'cancelled'), note: 'Merged into another order on the Channel' }
    expect(await applyOrderUpdate(ctx, org, connectionId, update(order.externalId, { facts: [removed] }))).toMatchObject({ factsApplied: 1 })
    expect(await getOrder(ctx, org, orderId)).toMatchObject({ phase: 'cancelled' })
    expect(await available()).toEqual({ stock: 10, reserved: 0, available: 10 })
  })

  it('applies the facts first: an update that cancels the Order leaves its addresses alone', async () => {
    const { ctx, org, connectionId, events, imported } = await setup()
    const { order, orderId } = await imported()
    const cancelled = update(order.externalId, { facts: [fact(`${order.externalId}:cancelled`, 'cancelled')], shippingAddress: delivery })
    expect(await applyOrderUpdate(ctx, org, connectionId, cancelled)).toEqual({ found: true, orderId, factsApplied: 1, addresses: 'not_new' })
    expect(await getOrder(ctx, org, orderId)).toMatchObject({ phase: 'cancelled', shippingAddress: order.shippingAddress })
    expect(await events(orderId)).not.toContain('order.addresses_updated')
  })

  it('never writes addresses back once the Buyer data was erased', async () => {
    const { ctx, org, connectionId, imported } = await setup()
    const { order, orderId } = await imported()
    await ctx.db.order.updateMany({ where: { id: orderId }, data: { buyerData: null, buyerEmailIndex: null, buyerDataErasedAt: new Date() } })
    expect(await applyOrderUpdate(ctx, org, connectionId, update(order.externalId, { shippingAddress: delivery }))).toMatchObject({ addresses: 'erased' })
    expect(await ctx.db.order.findFirstOrThrow({ where: { id: orderId } })).toMatchObject({ buyerData: null })
  })

  it('leaves a sealed value that does not open as it is, and still applies the facts', async () => {
    const { ctx, org, connectionId, imported } = await setup()
    const { order, orderId } = await imported()
    await ctx.db.order.updateMany({ where: { id: orderId }, data: { buyerData: 'v1.damaged' } })
    const result = await applyOrderUpdate(ctx, org, connectionId, update(order.externalId, { facts: [fact('p', 'paid')], shippingAddress: delivery }))
    expect(result).toMatchObject({ factsApplied: 1, addresses: 'unreadable' })
    expect(await ctx.db.order.findFirstOrThrow({ where: { id: orderId } })).toMatchObject({ buyerData: 'v1.damaged', phase: 'new' })
    expect(await ctx.db.orderChannelFact.count({ where: { orderId } })).toBe(1)
  })

  it("does not touch another organization's Order with the same external id", async () => {
    const { ctx, org, imported } = await setup()
    const { order, orderId } = await imported()
    const other = await createTestOrganization(ctx.db)
    const otherConnection = await createTestConnection(ctx, other)
    expect(await applyOrderUpdate(ctx, other, otherConnection, update(order.externalId, { facts: [fact('c', 'cancelled')] }))).toEqual({ found: false })
    await expect(applyOrderUpdate(ctx, other, (await ctx.db.order.findFirstOrThrow({ where: { id: orderId } })).connectionId, update(order.externalId))).rejects.toThrow()
    expect(await getOrder(ctx, org, orderId)).toMatchObject({ phase: 'new' })
  })
})
