import { randomUUID } from 'node:crypto'
import { createDb } from '@hanza/db'
import { describe, expect, it } from 'vitest'
import type { Actor } from '../actor'
import type { Context } from '../context'
import { PermanentJobError } from '../jobs'
import { orderStatusesDeleteJob } from '../jobs/order-statuses-delete'
import { syncTickJob } from '../jobs/sync-tick'
import { changeOrderStatus } from '../orders/change-status'
import { importOrder } from '../orders/import'
import { createTestOrganization, type TestContext } from '../testing/context'
import { databaseUrl, useTestContext } from '../testing/db-test'
import { buildOrder, createTestConnection } from '../testing/fixtures'
import { uniqueApplicationName, untilLockWait } from '../testing/lock-waits'
import { TX_OPTIONS } from '../transaction'
import { deleteOrderStatus, finishOrderStatusDeletion } from './delete'
import { getStatusMapping, setStatusMapping } from './mapping'
import { createOrderStatus, listOrderStatuses, makeDefaultOrderStatus, setOrderStatusActive } from './statuses'

const applicationName = uniqueApplicationName('hanza-status-deletion')
const run = { attempt: 1, maxAttempts: 5, retriedLater: 0 }

async function addAdmin(ctx: TestContext, organizationId: string): Promise<Actor> {
  const userId = randomUUID()
  await ctx.db.user.create({ data: { id: userId, name: 'Admin', email: `${userId}@example.org` } })
  await ctx.db.member.create({ data: { id: randomUUID(), organizationId, userId, role: 'admin', createdAt: new Date() } })
  return { type: 'user', userId }
}

// A status in use is deleted in two steps (ADR 0018): marked with its replacement at once, its Orders moved by the
// `orderStatuses.delete` job. These tests change things between the two steps.
describe.skipIf(!databaseUrl)('deleting an Order status while things change around it', () => {
  const context = useTestContext({ applicationName })

  async function setup() {
    const ctx = context()
    const org = await createTestOrganization(ctx.db)
    const admin = await addAdmin(ctx, org)
    const connectionId = await createTestConnection(ctx, org)
    const create = async (name: string) => (await createOrderStatus(ctx, org, { phase: 'processing', name, color: null }, admin)).statusId
    const a = await create('A')
    const b = await create('B')
    const c = await create('C')
    const orderIds: string[] = []
    for (let i = 0; i < 3; i++) {
      const { orderId } = await importOrder(ctx, org, connectionId, buildOrder())
      await changeOrderStatus(ctx, org, orderId, { statusId: a }, admin)
      orderIds.push(orderId)
    }
    const status = (id: string) => ctx.db.orderStatus.findFirst({ where: { id, organizationId: org } })
    const statusIdsOfOrders = async () =>
      [...new Set((await ctx.db.order.findMany({ where: { id: { in: orderIds } }, select: { statusId: true } })).map((order) => order.statusId))]
    const processingDefault = (await listOrderStatuses(ctx, org)).find((row) => row.phase === 'processing' && row.isDefault)!.id
    const jobsFor = (statusId: string) =>
      ctx.queue.waiting.filter((job) => job.name === 'orderStatuses.delete' && (job.payload as { statusId: string }).statusId === statusId)
    return { ctx, org, admin, connectionId, a, b, c, orderIds, status, statusIdsOfOrders, processingDefault, jobsFor }
  }

  it('marks the status, moves its mappings and records both before the worker moves its Orders', async () => {
    const { ctx, org, admin, connectionId, status } = await setup()
    // A Status mapping only covers the phases a Channel reports, so this one is of phase new.
    const toCheck = (await createOrderStatus(ctx, org, { phase: 'new', name: 'To check', color: null }, admin)).statusId
    const checked = (await createOrderStatus(ctx, org, { phase: 'new', name: 'Checked', color: null }, admin)).statusId
    await setStatusMapping(ctx, org, connectionId, { new: toCheck }, admin)
    await importOrder(ctx, org, connectionId, buildOrder())
    expect(await deleteOrderStatus(ctx, org, toCheck, checked, admin)).toEqual({ deleted: false })
    expect(await getStatusMapping(ctx, org, connectionId)).toMatchObject({ new: checked })
    expect(await status(toCheck)).toMatchObject({ active: false, replacedById: checked })
    expect((await status(toCheck))?.deletionDueAt).not.toBeNull()

    const events = await ctx.db.eventLog.findMany({
      where: { organizationId: org, type: { in: ['order_status.deletion_requested', 'connection.status_mapping_changed'] }, createdAt: { gte: new Date(Date.now() - 60_000) } },
      orderBy: { id: 'asc' },
    })
    expect(events.slice(-2).map((event) => [event.type, event.payload])).toEqual([
      [
        'order_status.deletion_requested',
        { phase: 'new', name: 'To check', wasActive: true, replacement: { id: checked, name: 'Checked', phase: 'new' }, actor: admin },
      ],
      [
        'connection.status_mapping_changed',
        {
          phase: 'new',
          from: { id: toCheck, name: 'To check', phase: 'new' },
          to: { id: checked, name: 'Checked', phase: 'new' },
          cause: 'status_deleted',
          actor: admin,
        },
      ],
    ])
  })

  it('(a) refuses to delete or deactivate the replacement of a pending deletion, and the job then finishes', async () => {
    const { ctx, org, admin, a, b, c, status, statusIdsOfOrders, jobsFor } = await setup()
    expect(await deleteOrderStatus(ctx, org, a, b, admin)).toEqual({ deleted: false })
    expect(jobsFor(a)).toHaveLength(1)

    await expect(deleteOrderStatus(ctx, org, b, c, admin)).rejects.toMatchObject({ code: 'status_is_replacement' })
    await expect(deleteOrderStatus(ctx, org, b, null, admin)).rejects.toMatchObject({ code: 'status_is_replacement' })
    await expect(setOrderStatusActive(ctx, org, b, false, admin)).rejects.toMatchObject({ code: 'status_is_replacement' })
    await expect(setOrderStatusActive(ctx, org, a, true, admin)).rejects.toMatchObject({ code: 'status_pending_deletion' })
    await expect(makeDefaultOrderStatus(ctx, org, a, admin)).rejects.toMatchObject({ code: 'status_inactive' })
    // The database refuses it too.
    await expect(ctx.db.$executeRaw`DELETE FROM "order_status" WHERE "id" = ${b}`).rejects.toThrow(/foreign key/i)

    await orderStatusesDeleteJob.handler(ctx, jobsFor(a)[0]!.payload as never, run)
    expect(await status(a)).toBeNull()
    expect(await statusIdsOfOrders()).toEqual([b])
    // Now B is free again.
    expect(await deleteOrderStatus(ctx, org, b, c, admin)).toEqual({ deleted: false })
  })

  it('(b) a replacement deactivated or deleted behind the services gives way to the phase default', async () => {
    const { ctx, org, admin, a, b, status, statusIdsOfOrders, processingDefault } = await setup()
    await deleteOrderStatus(ctx, org, a, b, admin)
    await ctx.db.$executeRaw`UPDATE "order_status" SET "active" = false WHERE "id" = ${b}`

    expect(await finishOrderStatusDeletion(ctx, org, a, admin)).toEqual({ moved: 3 })
    expect(await status(a)).toBeNull()
    expect(await statusIdsOfOrders()).toEqual([processingDefault])
    const deleted = await ctx.db.eventLog.findFirstOrThrow({ where: { organizationId: org, type: 'order_status.deleted', subjectId: a } })
    expect(deleted.payload).toMatchObject({ replacement: { id: processingDefault, name: null, phase: 'processing' }, moved: 3 })
  })

  it('(c) a Status mapping waits for a deletion starting on its status and is then refused; one made before is moved', async () => {
    const { ctx, org, admin, connectionId } = await setup()
    const toCheck = (await createOrderStatus(ctx, org, { phase: 'new', name: 'To check', color: null }, admin)).statusId
    const checked = (await createOrderStatus(ctx, org, { phase: 'new', name: 'Checked', color: null }, admin)).statusId

    // Another session is in the first step of deleting "To check": status locked, deactivated, marked, not committed.
    const holder = createDb(databaseUrl!)
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let marked!: () => void
    const isMarked = new Promise<void>((resolve) => (marked = resolve))
    const deleting = holder.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "order_status" WHERE "id" IN (${toCheck}, ${checked}) ORDER BY "id" FOR NO KEY UPDATE`
      await tx.$executeRaw`
        UPDATE "order_status" SET "active" = false, "replacedById" = ${checked}, "deletionDueAt" = now() + interval '10 minutes'
        WHERE "id" = ${toCheck}`
      marked()
      await released
    }, { ...TX_OPTIONS, timeout: 30_000 })
    await isMarked

    const mapping = setStatusMapping(ctx, org, connectionId, { new: toCheck }, admin)
    const outcome = mapping.then(
      () => 'saved',
      (error: { code?: string }) => error.code,
    )
    await untilLockWait(holder, applicationName)
    release()
    await deleting
    expect(await outcome).toBe('status_pending_deletion')
    await holder.$disconnect()
    expect(await getStatusMapping(ctx, org, connectionId)).toMatchObject({ new: null })

    // A mapping that slipped onto the status anyway (written by hand here) is moved by the job's next round.
    await ctx.db.$executeRaw`
      INSERT INTO "channel_status_mapping" ("id", "organizationId", "connectionId", "phase", "statusId", "updatedAt")
      VALUES (gen_random_uuid()::text, ${org}, ${connectionId}, 'new', ${toCheck}, now())`
    expect(await finishOrderStatusDeletion(ctx, org, toCheck, admin)).toEqual({ moved: 0 })
    expect(await getStatusMapping(ctx, org, connectionId)).toMatchObject({ new: checked })
    expect(await ctx.db.orderStatus.count({ where: { id: toCheck } })).toBe(0)
  })

  it('recovers a lost enqueue: sync.tick enqueues a deletion still marked once its due time has passed', async () => {
    const { ctx, org, admin, a, b, status, statusIdsOfOrders } = await setup()
    const queueDown: Context = {
      ...ctx,
      queue: {
        ...ctx.queue,
        enqueue: async () => {
          throw new Error('Redis unavailable')
        },
      },
    }
    expect(await deleteOrderStatus(queueDown, org, a, b, admin)).toEqual({ deleted: false })
    const enqueued = () =>
      ctx.queue.enqueued.filter((job) => job.name === 'orderStatuses.delete' && (job.payload as { statusId: string }).statusId === a)
    expect(enqueued()).toEqual([])

    await syncTickJob.handler(ctx, {}, run)
    expect(enqueued()).toEqual([])

    await ctx.db.$executeRaw`UPDATE "order_status" SET "deletionDueAt" = now() - interval '1 second' WHERE "id" = ${a}`
    await syncTickJob.handler(ctx, {}, run)
    expect(enqueued()).toEqual([
      { name: 'orderStatuses.delete', payload: { organizationId: org, statusId: a, actor: { type: 'system' } }, options: { coalesceKey: `orderStatuses.delete:${a}` } },
    ])
    expect((await status(a))?.deletionDueAt?.getTime()).toBeGreaterThan(Date.now())

    await orderStatusesDeleteJob.handler(ctx, enqueued()[0]!.payload as never, run)
    expect(await status(a)).toBeNull()
    expect(await statusIdsOfOrders()).toEqual([b])
  })

  it('is idempotent: deleting again resumes, a finished deletion does nothing, a status not being deleted fails the job for good', async () => {
    const { ctx, org, admin, a, b, c, status, statusIdsOfOrders, jobsFor } = await setup()
    expect(await deleteOrderStatus(ctx, org, a, b, admin)).toEqual({ deleted: false })
    // Asking again (any replacement) keeps the first one and only enqueues the job again.
    expect(await deleteOrderStatus(ctx, org, a, c, admin)).toEqual({ deleted: false })
    expect((await status(a))?.replacedById).toBe(b)

    expect(await finishOrderStatusDeletion(ctx, org, a, admin, { batchSize: 1 })).toEqual({ moved: 3 })
    expect(await finishOrderStatusDeletion(ctx, org, a, admin)).toEqual({ moved: 0 })
    await orderStatusesDeleteJob.handler(ctx, jobsFor(a)[0]!.payload as never, run)
    expect(await statusIdsOfOrders()).toEqual([b])
    expect(await ctx.db.eventLog.count({ where: { organizationId: org, type: 'order_status.deleted', subjectId: a } })).toBe(1)

    await expect(finishOrderStatusDeletion(ctx, org, c, admin)).rejects.toBeInstanceOf(PermanentJobError)
  })
})
