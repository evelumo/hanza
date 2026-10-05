import { createFakeChannel, type FakeChannel } from '@hanza/connector-fake'
import {
  addConnection,
  buildJobs,
  changeOrderStatus,
  createProduct,
  defineWorkflow,
  PermanentJobError,
  STEP_LEASE_MS,
  systemActor,
  systemCheckWorkflow,
  workflows,
  workflowStepRef,
  workflowSweepRef,
  type Actor,
  type JobDefinition,
} from '@hanza/core'
import { createTestContext, createTestOrganization, type TestContext } from '@hanza/core/testing'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { z } from 'zod'

const databaseUrl = inject('hanzaTestDatabaseUrl')
const user: Actor = { type: 'user', userId: 'user-1' }
const FAKE_ID = 'fake-workflows'

// Step calls by run id, to show which steps ran and how often.
const calls = new Map<string, string[]>()
function called(runId: string, step: string) {
  calls.set(runId, [...(calls.get(runId) ?? []), step])
}

const pipeline = defineWorkflow({ name: 'test.pipeline', input: z.object({ base: z.number(), flakyFailures: z.number().default(0) }) })
  .step('first', async ({ runId, input }) => {
    called(runId, 'first')
    return { value: input.base + 1 }
  })
  .step('flaky', async ({ runId, input, results, attempt }) => {
    called(runId, `flaky#${attempt}`)
    if (attempt <= input.flakyFailures) throw new Error(`flaky failure ${attempt}`)
    return { value: results.first.value * 10 }
  })
  .step('last', async ({ runId, results }) => {
    called(runId, 'last')
    return { total: results.flaky.value + 1 }
  })

const timer = defineWorkflow({ name: 'test.timer', input: z.object({}) })
  .step('before', async ({ runId }) => called(runId, 'before'))
  .sleep('pause', 3_600_000)
  .step('after', async ({ runId }) => called(runId, 'after'))

const approval = defineWorkflow({ name: 'test.approval', input: z.object({}) })
  .step('before', async ({ runId }) => called(runId, 'before'))
  .waitForSignal('approved', 'approved', z.object({ by: z.string().min(1) }), { timeoutMs: 86_400_000 })
  .step('after', async ({ runId, results }) => {
    called(runId, 'after')
    return { approvedBy: results.approved.by }
  })

const doomed = defineWorkflow({ name: 'test.doomed', input: z.object({ permanent: z.boolean() }) }).step('boom', async ({ runId, input }) => {
  called(runId, 'boom')
  throw input.permanent ? new PermanentJobError('cannot ever work') : new Error('still broken')
})

// A step that hangs on its first run, like a worker that died in the middle of it.
const hanging = new Map<string, () => void>()
const slow = defineWorkflow({ name: 'test.slow', input: z.object({}) }).step('work', async ({ runId }) => {
  called(runId, 'work')
  if (!hanging.has(runId)) {
    await new Promise<void>((resolve) => hanging.set(runId, resolve))
    return { by: 'first' }
  }
  return { by: 'second' }
})

const gates = new Map<string, () => void>()
const gated = defineWorkflow({ name: 'test.gated', input: z.object({}) })
  .step('work', async ({ runId }) => {
    called(runId, 'work')
    await new Promise<void>((resolve) => gates.set(runId, resolve))
    return { done: true }
  })
  .step('next', async ({ runId }) => called(runId, 'next'))

const concurrent = defineWorkflow({ name: 'test.concurrent', input: z.object({}) }).step('work', async ({ runId }) => {
  called(runId, 'work')
  await new Promise((resolve) => setTimeout(resolve, 50))
  return null
})

// Order → label → ship: the label comes from outside as a signal; shipping pushes the status to the Channel.
const fulfil = defineWorkflow({ name: 'test.fulfil', input: z.object({ orderId: z.string() }) })
  .waitForSignal('label', 'label.created', z.object({ trackingNumber: z.string() }))
  .step('ship', async ({ ctx, organizationId, input, results }) => {
    const order = await ctx.db.order.findFirstOrThrow({ where: { id: input.orderId, organizationId }, select: { status: true } })
    // At-least-once: a repeated run must not try the transition again.
    if (order.status !== 'shipped') await changeOrderStatus(ctx, organizationId, input.orderId, 'shipped', systemActor)
    return { trackingNumber: results.label.trackingNumber }
  })

describe.skipIf(!databaseUrl)('durable workflows end to end (real Postgres, in-memory queue, the worker job list)', () => {
  let ctx: TestContext
  let fake: FakeChannel
  let org: string
  let clock: Date
  const testJobs = buildJobs([...workflows, pipeline, timer, approval, doomed, slow, gated, concurrent, fulfil])
  const stepJob = testJobs.find((job) => job.name === workflowStepRef.name) as JobDefinition

  beforeAll(async () => {
    // Far in the future, so a parallel test file's sweep (real time) never finds these runs due.
    clock = new Date('2100-01-01T00:00:00Z')
    vi.setSystemTime(clock)
    fake = createFakeChannel()
    // Its own connector id: the other test file's `sync.tick` (same database) skips Connections it cannot resolve.
    ctx = createTestContext({ databaseUrl: databaseUrl!, connectors: [{ ...fake.connector, id: FAKE_ID }] })
    org = await createTestOrganization(ctx.db)
  })

  afterAll(async () => {
    vi.useRealTimers()
    await ctx?.db.$disconnect()
  })

  function travel(ms: number) {
    clock = new Date(clock.getTime() + ms)
    vi.setSystemTime(clock)
  }

  async function drain() {
    const result = await ctx.queue.drain(ctx, testJobs)
    expect(result.failed).toEqual([])
    return result
  }

  /** What `sync.tick` enqueues every minute for workflows. */
  async function sweep() {
    await ctx.queue.enqueue(workflowSweepRef, {})
    return drain()
  }

  async function run(runId: string) {
    return ctx.db.workflowRun.findFirstOrThrow({ where: { id: runId, organizationId: org } })
  }

  it('runs the registered system.check: a step, a durable timer, then a step using the first result', async () => {
    const { runId } = await ctx.workflows.start(systemCheckWorkflow, org, { requestedBy: 'user-1' })
    await drain()
    expect(await run(runId)).toMatchObject({ status: 'sleeping', currentStep: 'pause', wakeAt: new Date(clock.getTime() + 1_000) })

    travel(1_000)
    await sweep()
    const done = await ctx.workflows.get(org, runId)
    expect(done).toMatchObject({
      status: 'completed',
      currentStep: null,
      results: { ping: { eventId: `${runId}:ping` }, pong: { eventId: `${runId}:pong` } },
    })
    const events = await ctx.db.eventLog.findMany({ where: { organizationId: org, type: 'system.ping' }, orderBy: { id: 'asc' } })
    expect(events.map((event) => [event.id, event.payload])).toEqual([
      [`${runId}:ping`, { requestedBy: 'user-1', workflowRunId: runId }],
      [`${runId}:pong`, { requestedBy: 'user-1', workflowRunId: runId, replyTo: `${runId}:ping` }],
    ])
  })

  it('runs steps in order with earlier results passed on, retrying a failing step until the run resumes', async () => {
    const { runId } = await ctx.workflows.start(pipeline, org, { base: 4, flakyFailures: 2 })
    const { ran } = await drain()
    expect(calls.get(runId)).toEqual(['first', 'flaky#1', 'flaky#2', 'flaky#3', 'last'])
    expect(ran).toBe(5)
    expect(await ctx.workflows.get(org, runId)).toMatchObject({
      status: 'completed',
      results: { first: { value: 5 }, flaky: { value: 50 }, last: { total: 51 } },
      attempts: 0,
      lastError: null,
      finishedAt: clock,
    })
  })

  it('records the error of a failed attempt on the run while the retry waits', async () => {
    const { runId } = await ctx.workflows.start(pipeline, org, { base: 1, flakyFailures: 1 })
    await ctx.queue.drain(ctx, testJobs, { maxJobs: 2 })
    expect(await run(runId)).toMatchObject({ status: 'running', currentStep: 'flaky', attempts: 1, lastError: 'flaky failure 1' })
    await drain()
    expect(await run(runId)).toMatchObject({ status: 'completed', lastError: null })
  })

  it('fails the run after the last attempt, or at once on PermanentJobError', async () => {
    const { runId: retried } = await ctx.workflows.start(doomed, org, { permanent: false })
    const first = await ctx.queue.drain(ctx, testJobs)
    expect(first.failed).toMatchObject([{ name: 'workflow.step', attempts: 5 }])
    expect(calls.get(retried)).toHaveLength(5)
    expect(await run(retried)).toMatchObject({ status: 'failed', currentStep: 'boom', lastError: 'still broken', attempts: 5, wakeAt: null })

    const { runId: permanent } = await ctx.workflows.start(doomed, org, { permanent: true })
    const second = await ctx.queue.drain(ctx, testJobs)
    expect(second.failed).toMatchObject([{ name: 'workflow.step', attempts: 1 }])
    expect(await run(permanent)).toMatchObject({ status: 'failed', lastError: 'cannot ever work' })

    // A failed run stays failed: the sweep does not pick it up.
    await sweep()
    expect(calls.get(retried)).toHaveLength(5)
  })

  it('recovers a crash between steps (state committed, next job never enqueued) without re-running completed steps', async () => {
    const { runId } = await ctx.workflows.start(pipeline, org, { base: 1 })
    const enqueue = ctx.queue.enqueue.bind(ctx.queue)
    const spy = vi.spyOn(ctx.queue, 'enqueue').mockImplementationOnce(async (job, payload, options) => {
      if (job.name === workflowStepRef.name) throw new Error('Redis connection lost')
      return enqueue(job, payload, options)
    })
    await drain()
    spy.mockRestore()

    expect(calls.get(runId)).toEqual(['first'])
    expect(ctx.queue.waiting).toEqual([])
    expect(await run(runId)).toMatchObject({ status: 'running', currentStep: 'flaky', results: { first: { value: 2 } } })

    await sweep()
    expect(calls.get(runId)).toEqual(['first', 'flaky#1', 'last'])
    expect(await run(runId)).toMatchObject({ status: 'completed', results: { first: { value: 2 }, flaky: { value: 20 }, last: { total: 21 } } })
  })

  it('runs a step again once the lease of a worker that died in it expired, and discards the late result', async () => {
    const { runId } = await ctx.workflows.start(slow, org, {})
    ctx.queue.waiting.length = 0
    const first = stepJob.handler(ctx, { organizationId: org, runId }, { attempt: 1, maxAttempts: 5, retriedLater: 0 })
    await vi.waitFor(() => expect(hanging.has(runId)).toBe(true))

    // Within the lease the sweep's job leaves the step to the worker holding it.
    travel(STEP_LEASE_MS - 1_000)
    await sweep()
    expect(calls.get(runId)).toEqual(['work'])

    travel(2_000)
    await sweep()
    expect(calls.get(runId)).toEqual(['work', 'work'])
    expect(await run(runId)).toMatchObject({ status: 'completed', results: { work: { by: 'second' } } })

    hanging.get(runId)!()
    await first
    expect(await run(runId)).toMatchObject({ status: 'completed', results: { work: { by: 'second' } } })
  })

  it('runs a step once when two jobs for the run race', async () => {
    const { runId } = await ctx.workflows.start(concurrent, org, {})
    ctx.queue.waiting.length = 0
    const job = () => stepJob.handler(ctx, { organizationId: org, runId }, { attempt: 1, maxAttempts: 5, retriedLater: 0 })
    await Promise.all([job(), job(), job()])
    expect(calls.get(runId)).toEqual(['work'])
    expect(await run(runId)).toMatchObject({ status: 'completed' })
  })

  it('fires a durable timer only once its time has passed', async () => {
    const { runId } = await ctx.workflows.start(timer, org, {})
    await drain()
    const sleeping = await run(runId)
    expect(sleeping).toMatchObject({ status: 'sleeping', currentStep: 'pause', wakeAt: new Date(clock.getTime() + 3_600_000) })
    // The delayed hint job ran early (the in-memory queue ignores delays) and changed nothing.
    expect(ctx.queue.enqueued.at(-1)).toMatchObject({ name: 'workflow.step', options: { delayMs: 3_600_000 } })

    travel(3_599_000)
    await sweep()
    expect(calls.get(runId)).toEqual(['before'])
    expect(await run(runId)).toMatchObject({ status: 'sleeping', version: sleeping.version })

    travel(1_000)
    await sweep()
    expect(calls.get(runId)).toEqual(['before', 'after'])
    expect(await run(runId)).toMatchObject({ status: 'completed' })
  })

  it('resumes a waiting run with a signal, by run id or by key, and keeps a signal sent early', async () => {
    const { runId } = await ctx.workflows.start(approval, org, {})
    await drain()
    expect(await run(runId)).toMatchObject({ status: 'waiting', currentStep: 'approved', wakeAt: new Date(clock.getTime() + 86_400_000) })
    await sweep()
    expect(await run(runId)).toMatchObject({ status: 'waiting' })

    await expect(ctx.workflows.signal(approval, org, { runId }, 'approved', { by: '' })).rejects.toThrow()
    expect(await ctx.workflows.signal(approval, org, { runId }, 'approved', { by: 'manager' })).toEqual({ delivered: true })
    await drain()
    expect(calls.get(runId)).toEqual(['before', 'after'])
    expect(await ctx.workflows.get(org, runId)).toMatchObject({ status: 'completed', results: { approved: { by: 'manager' }, after: { approvedBy: 'manager' } } })
    expect(await ctx.db.workflowSignal.count({ where: { organizationId: org, runId, consumedAt: null } })).toBe(0)
    expect(await ctx.workflows.signal(approval, org, { runId }, 'approved', { by: 'late' })).toEqual({ delivered: false })

    // Sent before the run reaches its wait step, and by key.
    const { runId: early } = await ctx.workflows.start(approval, org, {}, { key: 'order-42' })
    expect(await ctx.workflows.signal(approval, org, { key: 'order-42' }, 'approved', { by: 'early bird' })).toEqual({ delivered: true })
    await drain()
    expect(await ctx.workflows.get(org, early)).toMatchObject({ status: 'completed', results: { after: { approvedBy: 'early bird' } } })
  })

  it('recovers a signal whose job was lost through the sweep', async () => {
    const { runId } = await ctx.workflows.start(approval, org, {})
    await drain()
    await ctx.workflows.signal(approval, org, { runId }, 'approved', { by: 'manager' })
    ctx.queue.waiting.length = 0
    await sweep()
    expect(await run(runId)).toMatchObject({ status: 'completed' })
  })

  it('fails a wait whose timeout passed', async () => {
    const { runId } = await ctx.workflows.start(approval, org, {})
    await drain()
    travel(86_400_000)
    await sweep()
    expect(await run(runId)).toMatchObject({ status: 'failed', currentStep: 'approved', lastError: 'Timed out waiting for signal "approved"' })
  })

  it('cancels a sleeping and a waiting run: nothing runs afterwards', async () => {
    const { runId: sleeping } = await ctx.workflows.start(timer, org, {})
    const { runId: waiting } = await ctx.workflows.start(approval, org, {}, { key: 'to-cancel' })
    await drain()

    expect(await ctx.workflows.cancel(timer, org, { runId: sleeping })).toEqual({ cancelled: true })
    expect(await ctx.workflows.cancel(approval, org, { key: 'to-cancel' })).toEqual({ cancelled: true })
    expect(await ctx.workflows.cancel(approval, org, { key: 'to-cancel' })).toEqual({ cancelled: false })
    expect(await ctx.workflows.signal(approval, org, { runId: waiting }, 'approved', { by: 'too late' })).toEqual({ delivered: false })
    const cancelledAt = clock

    travel(86_400_000)
    await sweep()
    expect(calls.get(sleeping)).toEqual(['before'])
    expect(calls.get(waiting)).toEqual(['before'])
    expect(await run(sleeping)).toMatchObject({ status: 'cancelled', wakeAt: null, finishedAt: cancelledAt })
    expect(await run(waiting)).toMatchObject({ status: 'cancelled' })
  })

  it('discards the result of a step that was running when the run was cancelled', async () => {
    const { runId } = await ctx.workflows.start(gated, org, {})
    const draining = drain()
    await vi.waitFor(() => expect(gates.has(runId)).toBe(true))
    expect(await ctx.workflows.cancel(gated, org, { runId })).toEqual({ cancelled: true })
    gates.get(runId)!()
    await draining
    expect(calls.get(runId)).toEqual(['work'])
    expect(await run(runId)).toMatchObject({ status: 'cancelled', currentStep: 'work', results: {} })
  })

  it('starts at most one run per key', async () => {
    const first = await ctx.workflows.start(pipeline, org, { base: 1 }, { key: 'once' })
    const again = await ctx.workflows.start(pipeline, org, { base: 2 }, { key: 'once' })
    expect(first.created).toBe(true)
    expect(again).toEqual({ runId: first.runId, created: false })
    await drain()
    expect(await ctx.db.workflowRun.count({ where: { organizationId: org, workflow: pipeline.name, key: 'once' } })).toBe(1)
  })

  it('keeps runs tenant-scoped: another organization cannot read, signal or cancel them, and may reuse a key', async () => {
    const other = await createTestOrganization(ctx.db)
    const { runId } = await ctx.workflows.start(approval, org, {}, { key: 'shared-key' })
    await drain()

    expect(await ctx.workflows.get(other, runId)).toBeNull()
    expect(await ctx.workflows.list(other)).toEqual([])
    expect(await ctx.workflows.signal(approval, other, { runId }, 'approved', { by: 'intruder' })).toEqual({ delivered: false })
    expect(await ctx.workflows.signal(approval, other, { key: 'shared-key' }, 'approved', { by: 'intruder' })).toEqual({ delivered: false })
    expect(await ctx.workflows.cancel(approval, other, { runId })).toEqual({ cancelled: false })
    expect(await ctx.workflows.cancel(approval, other, { key: 'shared-key' })).toEqual({ cancelled: false })
    // A step job naming the wrong organization changes nothing.
    await stepJob.handler(ctx, { organizationId: other, runId }, { attempt: 1, maxAttempts: 5, retriedLater: 0 })
    expect(await run(runId)).toMatchObject({ status: 'waiting' })

    const { runId: theirs, created } = await ctx.workflows.start(approval, other, {}, { key: 'shared-key' })
    expect(created).toBe(true)
    expect(theirs).not.toBe(runId)
    expect((await ctx.workflows.list(other)).map((view) => view.id)).toEqual([theirs])
    expect((await ctx.workflows.list(org)).map((view) => view.id)).toContain(runId)
    expect(await ctx.db.workflowSignal.count({ where: { organizationId: other } })).toBe(0)
    await ctx.workflows.cancel(approval, org, { runId })
    await ctx.workflows.cancel(approval, other, { runId: theirs })
  })

  it('leaves a run of a workflow this worker does not know for a worker that does', async () => {
    const { runId } = await ctx.workflows.start(pipeline, org, { base: 1 })
    const result = await ctx.queue.drain(ctx, buildJobs(workflows))
    expect(result.failed).toEqual([])
    expect(calls.get(runId)).toBeUndefined()
    expect(await run(runId)).toMatchObject({ status: 'running', currentStep: 'first' })
    await sweep()
    expect(await run(runId)).toMatchObject({ status: 'completed' })
  })

  it('order flow: waits for a "label created" signal, then ships the Order and the status reaches the fake Channel', async () => {
    await createProduct(ctx, org, { sku: 'FAKE-SKU-1', name: 'Mug', stock: 5 }, user)
    const { connectionId } = await addConnection(
      ctx,
      org,
      { connectorId: FAKE_ID, name: 'Workflow channel', config: { failMode: 'none' }, credentials: { apiKey: 'test' } },
      user,
    )
    await drain()
    const order = await ctx.db.order.findFirstOrThrow({ where: { organizationId: org, connectionId, externalId: 'fake-order-1' } })
    expect(order.status).toBe('new')

    const { runId } = await ctx.workflows.start(fulfil, org, { orderId: order.id }, { key: order.id })
    await drain()
    expect(await run(runId)).toMatchObject({ status: 'waiting', currentStep: 'label' })
    expect(fake.statusUpdates).toEqual([])

    await ctx.workflows.signal(fulfil, org, { key: order.id }, 'label.created', { trackingNumber: 'TRACK-1' })
    await drain()
    expect(await ctx.workflows.get(org, runId)).toMatchObject({ status: 'completed', results: { ship: { trackingNumber: 'TRACK-1' } } })
    expect((await ctx.db.order.findFirstOrThrow({ where: { id: order.id, organizationId: org } })).status).toBe('shipped')
    expect(fake.statusUpdates).toContainEqual({ orderExternalId: 'fake-order-1', status: 'shipped' })
  })
})
