import { createFakeChannel, type FakeChannel } from '@hanza/connector-fake'
import {
  addConnection,
  buildJobs,
  changeOrderStatus,
  createProduct,
  defineWorkflow,
  MAX_JSON_BYTES,
  MAX_STEP_ATTEMPTS,
  PermanentJobError,
  RetryLaterError,
  STEP_LEASE_MS,
  systemActor,
  systemCheckWorkflow,
  WorkflowValueError,
  workflows,
  workflowStepRef,
  workflowSweepRef,
  type Actor,
  type AnyWorkflowDefinition,
  type JobDefinition,
} from '@hanza/core'
import { createTestContext, createTestOrganization, type TestContext } from '@hanza/core/testing'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { z } from 'zod'

// The sweep reads every organization's runs, and the other test files share this database: assertions
// here only look at this file's own runs, and its clock is far in the future (see `beforeAll`).

const databaseUrl = inject('hanzaTestDatabaseUrl')
const user: Actor = { type: 'user', userId: 'user-1' }
const FAKE_ID = 'fake-workflows'

// Step calls by run id, to show which steps ran and how often.
const calls = new Map<string, string[]>()
function called(runId: string, step: string) {
  calls.set(runId, [...(calls.get(runId) ?? []), step])
}

/** Promises a test settles by hand, by run id: a step "hangs" until then, like a slow or dead worker. */
const gates = new Map<string, Array<(outcome: string | Error) => void>>()
function hang(runId: string): Promise<string | Error> {
  return new Promise((resolve) => gates.set(runId, [...(gates.get(runId) ?? []), resolve]))
}
const waiting = (runId: string) => gates.get(runId)?.length ?? 0

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
  if (input.permanent) throw new PermanentJobError('cannot ever work')
  throw Object.assign(new Error('Request for buyer jan@example.com failed\nHTTP 503'), { code: 'E_UPSTREAM' })
})

const limited = defineWorkflow({ name: 'test.limited', input: z.object({}) }).step('call', async ({ runId, attempt }) => {
  called(runId, `call#${attempt}`)
  if ((calls.get(runId) ?? []).length === 1) throw new RetryLaterError(60_000, 'rate limited')
  return { ok: true }
})

/** Every execution hangs until the test settles it with a name (its result) or an error (thrown). */
const slow = defineWorkflow({ name: 'test.slow', input: z.object({}) })
  .step('work', async ({ runId }) => {
    called(runId, 'work')
    const outcome = await hang(runId)
    if (outcome instanceof Error) throw outcome
    return { by: outcome }
  })
  .step('next', async ({ runId }) => called(runId, 'next'))

const concurrent = defineWorkflow({ name: 'test.concurrent', input: z.object({}) }).step('work', async ({ runId }) => {
  called(runId, 'work')
  await new Promise((resolve) => setTimeout(resolve, 50))
  return null
})

const typed = defineWorkflow({
  name: 'test.typed',
  input: z.object({ count: z.string().transform(Number), at: z.string().transform((value) => new Date(value)) }),
})
  .step('use', async ({ input }) => ({ next: input.count + 1, day: input.at.toISOString().slice(0, 10) }))
  .waitForSignal('amount', 'amount', z.object({ value: z.string().transform(Number) }))
  .step('sum', async ({ results }) => ({ total: results.use.next + results.amount.value }))

const dated = defineWorkflow({ name: 'test.dated', input: z.object({ at: z.date() }) }).step('noop', async () => null)
const datedSignal = defineWorkflow({ name: 'test.datedSignal', input: z.object({}) }).waitForSignal('when', 'when', z.object({ at: z.date() }))
const bulky = defineWorkflow({ name: 'test.bulky', input: z.object({}) }).step('huge', async () => ({ text: 'x'.repeat(MAX_JSON_BYTES) }))

// One workflow name, changed between deploys.
const evolvingV1 = defineWorkflow({ name: 'test.evolving', input: z.object({}) })
  .step('a', async ({ runId }) => called(runId, 'a'))
  .step('b', async ({ runId }) => called(runId, 'b'))
  .step('c', async ({ runId }) => called(runId, 'c'))
const evolvingReordered = defineWorkflow({ name: 'test.evolving', input: z.object({}) })
  .step('b', async ({ runId }) => called(runId, 'b'))
  .step('a', async ({ runId }) => called(runId, 'a'))
  .step('c', async ({ runId }) => called(runId, 'c'))
const evolvingInserted = defineWorkflow({ name: 'test.evolving', input: z.object({}) })
  .step('a', async ({ runId }) => called(runId, 'a'))
  .step('x', async ({ runId }) => called(runId, 'x'))
  .step('b', async ({ runId }) => called(runId, 'b'))
  .step('c', async ({ runId }) => called(runId, 'c'))
const evolvingAppended = evolvingV1.step('d', async ({ runId }) => called(runId, 'd'))

// Order → label → ship: the label comes from outside as a signal; shipping pushes the status to the Channel.
const fulfil = defineWorkflow({ name: 'test.fulfil', input: z.object({ orderId: z.string() }) })
  .waitForSignal('label', 'label.created', z.object({ trackingNumber: z.string() }))
  .step('ship', async ({ ctx, organizationId, input, results }) => {
    const order = await ctx.db.order.findFirstOrThrow({ where: { id: input.orderId, organizationId }, select: { phase: true } })
    // At-least-once: a repeated run must not try the transition again.
    if (order.phase !== 'shipped') await changeOrderStatus(ctx, organizationId, input.orderId, 'shipped', systemActor)
    return { trackingNumber: results.label.trackingNumber }
  })

describe.skipIf(!databaseUrl)('durable workflows end to end (real Postgres, in-memory queue, the worker job list)', () => {
  let ctx: TestContext
  let fake: FakeChannel
  let org: string
  let clock: Date
  const known = [...workflows, pipeline, timer, approval, doomed, limited, slow, concurrent, typed, bulky, evolvingV1, fulfil]
  const testJobs = buildJobs(known)
  const stepJob = testJobs.find((job) => job.name === workflowStepRef.name) as JobDefinition

  beforeAll(async () => {
    // Far in the future, so another test file's sweep (real time) never finds these runs due.
    clock = new Date('2100-01-01T00:00:00Z')
    vi.setSystemTime(clock)
    fake = createFakeChannel()
    // Its own connector id: the other test files' `sync.tick` (same database) skips Connections it cannot resolve.
    ctx = createTestContext({ databaseUrl: databaseUrl!, connectors: [{ ...fake.connector, id: FAKE_ID }] })
    org = await createTestOrganization(ctx.db)
  })

  afterAll(async () => {
    for (const resolvers of gates.values()) for (const resolve of resolvers) resolve('cleanup')
    vi.useRealTimers()
    await ctx?.db.$disconnect()
  })

  function travel(ms: number) {
    clock = new Date(clock.getTime() + ms)
    vi.setSystemTime(clock)
  }

  async function drain(jobs: JobDefinition[] = testJobs) {
    const result = await ctx.queue.drain(ctx, jobs, { maxJobs: 5_000 })
    expect(result.failed).toEqual([])
    return result
  }

  /** What `sync.tick` enqueues every minute for workflows. */
  async function sweep() {
    await ctx.queue.enqueue(workflowSweepRef, {})
    return drain()
  }

  /** Runs only the sweep and returns the step jobs it enqueued for `runIds`, leaving them out of the queue. */
  async function sweepOnly(runIds: string[]): Promise<string[]> {
    await ctx.queue.enqueue(workflowSweepRef, {})
    await ctx.queue.drain(ctx, testJobs, { maxJobs: 1 })
    const swept = ctx.queue.waiting.map((job) => (job.payload as { runId: string }).runId)
    ctx.queue.waiting.length = 0
    return swept.filter((id) => runIds.includes(id))
  }

  /** A step job run outside the queue and not awaited, as on a worker that may hang in it. */
  function stepInBackground(runId: string) {
    return stepJob.handler(ctx, { organizationId: org, runId }, { attempt: 1, maxAttempts: 5, retriedLater: 0 })
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
    expect((await run(runId)).completedSteps).toEqual(['run:first', 'run:flaky', 'run:last'])
  })

  it('records a description of the failed attempt on the run while the retry waits', async () => {
    const { runId } = await ctx.workflows.start(pipeline, org, { base: 1, flakyFailures: 1 })
    await ctx.queue.drain(ctx, testJobs, { maxJobs: 2 })
    expect(await run(runId)).toMatchObject({ status: 'running', currentStep: 'flaky', attempts: 1, lastError: 'Error: flaky failure 1' })
    await drain()
    expect(await run(runId)).toMatchObject({ status: 'completed', lastError: null })
  })

  it('fails the run after the last attempt, or at once on PermanentJobError, storing no more than a description', async () => {
    const { runId: retried } = await ctx.workflows.start(doomed, org, { permanent: false })
    const first = await ctx.queue.drain(ctx, testJobs)
    expect(first.failed).toMatchObject([{ name: 'workflow.step', attempts: MAX_STEP_ATTEMPTS }])
    expect(calls.get(retried)).toHaveLength(MAX_STEP_ATTEMPTS)
    // Name, code and the last line only: the first line quoted a Buyer's e-mail.
    expect(await ctx.workflows.get(org, retried)).toMatchObject({
      status: 'failed',
      currentStep: 'boom',
      lastError: 'Error E_UPSTREAM: HTTP 503',
      attempts: MAX_STEP_ATTEMPTS,
      wakeAt: null,
    })

    const { runId: permanent } = await ctx.workflows.start(doomed, org, { permanent: true })
    const second = await ctx.queue.drain(ctx, testJobs)
    expect(second.failed).toMatchObject([{ name: 'workflow.step', attempts: 1 }])
    expect(await run(permanent)).toMatchObject({ status: 'failed', lastError: 'PermanentJobError: cannot ever work' })

    // A failed run stays failed: the sweep does not pick it up.
    await sweep()
    expect(calls.get(retried)).toHaveLength(MAX_STEP_ATTEMPTS)
  })

  it('retries a step later on RetryLaterError without using an attempt', async () => {
    const { runId } = await ctx.workflows.start(limited, org, {})
    await drain()
    expect(calls.get(runId)).toEqual(['call#1'])
    expect(await run(runId)).toMatchObject({
      status: 'running',
      attempts: 0,
      wakeAt: new Date(clock.getTime() + 60_000),
      lastError: 'RetryLaterError: rate limited',
    })

    travel(59_000)
    await sweep()
    expect(calls.get(runId)).toEqual(['call#1'])
    travel(1_000)
    await sweep()
    expect(calls.get(runId)).toEqual(['call#1', 'call#1'])
    expect(await run(runId)).toMatchObject({ status: 'completed', results: { call: { ok: true } } })
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

  it('starts a step again once its lease expired, and the first execution to finish commits even if it started first', async () => {
    const { runId } = await ctx.workflows.start(slow, org, {})
    ctx.queue.waiting.length = 0
    const first = stepInBackground(runId)
    await vi.waitFor(() => expect(waiting(runId)).toBe(1))
    expect(await run(runId)).toMatchObject({ attempts: 1, wakeAt: new Date(clock.getTime() + STEP_LEASE_MS) })

    // Within the lease nothing is due.
    travel(STEP_LEASE_MS - 1_000)
    expect(await sweepOnly([runId])).toEqual([])

    travel(2_000)
    expect(await sweepOnly([runId])).toEqual([runId])
    const second = stepInBackground(runId)
    await vi.waitFor(() => expect(waiting(runId)).toBe(2))
    expect(await run(runId)).toMatchObject({ status: 'running', attempts: 2 })

    // The step always outlives its lease: the execution that started first finishes first and commits.
    gates.get(runId)![0]!('first')
    await first
    expect(await run(runId)).toMatchObject({ currentStep: 'next', results: { work: { by: 'first' } }, attempts: 0 })
    gates.get(runId)![1]!('second')
    await second
    await drain()
    expect(await run(runId)).toMatchObject({ status: 'completed', results: { work: { by: 'first' }, next: null } })
    expect(calls.get(runId)).toEqual(['work', 'work', 'next'])
  })

  for (const [kind, error] of [
    ['an error', new Error('boom')],
    ['RetryLaterError', new RetryLaterError(30_000, 'rate limited')],
    ['PermanentJobError', new PermanentJobError('cannot ever work')],
  ] as const) {
    it(`ignores ${kind} from an execution whose lease was taken over: the newer execution keeps its claim and commits`, async () => {
      const { runId } = await ctx.workflows.start(slow, org, {})
      ctx.queue.waiting.length = 0
      const first = stepInBackground(runId)
      await vi.waitFor(() => expect(waiting(runId)).toBe(1))

      travel(STEP_LEASE_MS)
      expect(await sweepOnly([runId])).toEqual([runId])
      const second = stepInBackground(runId)
      await vi.waitFor(() => expect(waiting(runId)).toBe(2))
      const claimed = await run(runId)
      expect(claimed).toMatchObject({ status: 'running', attempts: 2, wakeAt: new Date(clock.getTime() + STEP_LEASE_MS) })

      travel(60_000)
      gates.get(runId)![0]!(error)
      // The stale execution's error is logged and dropped: its job does not fail or retry.
      await expect(first).resolves.toBeUndefined()
      expect(await run(runId)).toMatchObject({
        status: 'running',
        attempts: 2,
        wakeAt: claimed.wakeAt,
        claimToken: claimed.claimToken,
        lastError: null,
      })
      // Neither the queue's retry of the stale job nor the sweep starts a third execution.
      await stepInBackground(runId)
      expect(await sweepOnly([runId])).toEqual([])
      expect(waiting(runId)).toBe(2)

      gates.get(runId)![1]!('second')
      await second
      await drain()
      expect(await run(runId)).toMatchObject({ status: 'completed', results: { work: { by: 'second' }, next: null } })
    })
  }

  it(`fails a run whose step never finishes or throws (a worker that dies in it) after ${MAX_STEP_ATTEMPTS} attempts`, async () => {
    const { runId } = await ctx.workflows.start(slow, org, {})
    ctx.queue.waiting.length = 0
    const executions: Array<Promise<void>> = []
    for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt++) {
      executions.push(stepInBackground(runId))
      await vi.waitFor(() => expect(waiting(runId)).toBe(attempt))
      expect((await run(runId)).attempts).toBe(attempt)
      travel(STEP_LEASE_MS)
      expect(await sweepOnly([runId])).toEqual([runId])
    }
    await stepInBackground(runId)
    expect(waiting(runId)).toBe(MAX_STEP_ATTEMPTS)
    expect(await run(runId)).toMatchObject({ status: 'failed', lastError: `Step "work" did not finish in ${MAX_STEP_ATTEMPTS} attempts` })

    // A hung execution that comes back late cannot revive the run.
    for (const resolve of gates.get(runId)!) resolve('late')
    await Promise.all(executions)
    expect(await run(runId)).toMatchObject({ status: 'failed', results: {} })
  })

  it('runs a step once when several jobs for the run race', async () => {
    const { runId } = await ctx.workflows.start(concurrent, org, {})
    ctx.queue.waiting.length = 0
    await Promise.all([stepInBackground(runId), stepInBackground(runId), stepInBackground(runId)])
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
    expect(await run(runId)).toMatchObject({
      status: 'waiting',
      currentStep: 'approved',
      waitingFor: 'approved',
      wakeAt: new Date(clock.getTime() + 86_400_000),
    })
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
    const { runId: waitingRun } = await ctx.workflows.start(approval, org, {}, { key: 'to-cancel' })
    await drain()

    expect(await ctx.workflows.cancel(timer, org, { runId: sleeping })).toEqual({ cancelled: true })
    expect(await ctx.workflows.cancel(approval, org, { key: 'to-cancel' })).toEqual({ cancelled: true })
    expect(await ctx.workflows.cancel(approval, org, { key: 'to-cancel' })).toEqual({ cancelled: false })
    expect(await ctx.workflows.signal(approval, org, { runId: waitingRun }, 'approved', { by: 'too late' })).toEqual({ delivered: false })
    const cancelledAt = clock

    travel(86_400_000)
    await sweep()
    expect(calls.get(sleeping)).toEqual(['before'])
    expect(calls.get(waitingRun)).toEqual(['before'])
    expect(await run(sleeping)).toMatchObject({ status: 'cancelled', wakeAt: null, finishedAt: cancelledAt })
    expect(await run(waitingRun)).toMatchObject({ status: 'cancelled', waitingFor: null })
  })

  it('discards the result of a step that was running when the run was cancelled', async () => {
    const { runId } = await ctx.workflows.start(slow, org, {})
    const draining = drain()
    await vi.waitFor(() => expect(waiting(runId)).toBe(1))
    expect(await ctx.workflows.cancel(slow, org, { runId })).toEqual({ cancelled: true })
    gates.get(runId)![0]!('too late')
    await draining
    expect(calls.get(runId)).toEqual(['work'])
    expect(await run(runId)).toMatchObject({ status: 'cancelled', currentStep: 'work', results: {} })
  })

  it('starts at most one run per key, returning it even with another input', async () => {
    const first = await ctx.workflows.start(pipeline, org, { base: 1 }, { key: 'once' })
    const again = await ctx.workflows.start(pipeline, org, { base: 2 }, { key: 'once' })
    expect(first.created).toBe(true)
    expect(again).toEqual({ runId: first.runId, created: false })
    await drain()
    expect(await ctx.workflows.start(pipeline, org, { base: 3 }, { key: 'once' })).toEqual({ runId: first.runId, created: false })
    expect(await ctx.db.workflowRun.count({ where: { organizationId: org, workflow: pipeline.name, key: 'once' } })).toBe(1)
    expect((await run(first.runId)).input).toEqual({ base: 1 })
  })

  it('stores the input and signal payloads as given, so schemas with transforms read them back the same', async () => {
    const { runId } = await ctx.workflows.start(typed, org, { count: '41', at: '2100-01-02T03:04:05.000Z' })
    await drain()
    expect(await run(runId)).toMatchObject({ status: 'waiting', input: { count: '41', at: '2100-01-02T03:04:05.000Z' } })
    await ctx.workflows.signal(typed, org, { runId }, 'amount', { value: '8' })
    expect(await ctx.db.workflowSignal.findFirstOrThrow({ where: { organizationId: org, runId } })).toMatchObject({ payload: { value: '8' } })
    await drain()
    expect(await ctx.workflows.get(org, runId)).toMatchObject({
      status: 'completed',
      results: { use: { next: 42, day: '2100-01-02' }, amount: { value: 8 }, sum: { total: 50 } },
    })
  })

  it('refuses at start and signal what would not read back from JSON or is too large, instead of failing the run later', async () => {
    const runsBefore = await ctx.db.workflowRun.count({ where: { organizationId: org } })
    await expect(ctx.workflows.start(dated, org, { at: new Date() })).rejects.toThrow(WorkflowValueError)
    await expect(ctx.workflows.start(pipeline, org, { base: 1, padding: 'x'.repeat(MAX_JSON_BYTES) } as never)).rejects.toThrow(
      'larger than 256 KB',
    )
    expect(await ctx.db.workflowRun.count({ where: { organizationId: org } })).toBe(runsBefore)

    const { runId } = await ctx.workflows.start(datedSignal, org, {})
    await expect(ctx.workflows.signal(datedSignal, org, { runId }, 'when', { at: new Date() })).rejects.toThrow(WorkflowValueError)
    await expect(ctx.workflows.signal(approval, org, { runId }, 'approved', { by: 'x'.repeat(MAX_JSON_BYTES) })).rejects.toThrow(
      'larger than 256 KB',
    )
    expect(await ctx.db.workflowSignal.count({ where: { organizationId: org, runId } })).toBe(0)
    await ctx.workflows.cancel(datedSignal, org, { runId })
  })

  it('fails the run when a step result is larger than the limit', async () => {
    const { runId } = await ctx.workflows.start(bulky, org, {})
    const result = await ctx.queue.drain(ctx, testJobs)
    expect(result.failed).toMatchObject([{ name: 'workflow.step', error: expect.any(PermanentJobError) }])
    expect(await run(runId)).toMatchObject({ status: 'failed', results: {}, lastError: expect.stringContaining('larger than 256 KB') })
  })

  it('fails a run whose definition changed under it instead of re-running or skipping a step (issue #43), but continues after appended steps', async () => {
    const withDefinition = (definition: AnyWorkflowDefinition) => buildJobs([...known.filter((known) => known.name !== definition.name), definition])
    const startAfterA = async () => {
      const { runId } = await ctx.workflows.start(evolvingV1, org, {})
      await ctx.queue.drain(ctx, testJobs, { maxJobs: 1 })
      ctx.queue.waiting.length = 0
      expect(await run(runId)).toMatchObject({ status: 'running', currentStep: 'b', completedSteps: ['run:a'] })
      return runId
    }
    const changedError = 'Workflow "test.evolving" changed while the run was in step "b": its steps no longer match the steps already done'

    const swapped = await startAfterA()
    await ctx.queue.enqueue(workflowStepRef, { organizationId: org, runId: swapped })
    await drain(withDefinition(evolvingReordered))
    expect(calls.get(swapped)).toEqual(['a'])
    expect(await run(swapped)).toMatchObject({ status: 'failed', lastError: changedError, results: { a: null } })

    const inserted = await startAfterA()
    await ctx.queue.enqueue(workflowStepRef, { organizationId: org, runId: inserted })
    await drain(withDefinition(evolvingInserted))
    expect(calls.get(inserted)).toEqual(['a'])
    expect(await run(inserted)).toMatchObject({ status: 'failed', lastError: changedError })

    const appended = await startAfterA()
    await ctx.queue.enqueue(workflowStepRef, { organizationId: org, runId: appended })
    await drain(withDefinition(evolvingAppended))
    expect(calls.get(appended)).toEqual(['a', 'b', 'c', 'd'])
    expect(await run(appended)).toMatchObject({ status: 'completed', completedSteps: ['run:a', 'run:b', 'run:c', 'run:d'] })
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
    // The database itself refuses a signal of one organization for another organization's run.
    await expect(ctx.db.workflowSignal.create({ data: { organizationId: other, runId, name: 'approved', payload: { by: 'intruder' } } })).rejects.toThrow()

    const { runId: theirs, created } = await ctx.workflows.start(approval, other, {}, { key: 'shared-key' })
    expect(created).toBe(true)
    expect(theirs).not.toBe(runId)
    expect((await ctx.workflows.list(other)).map((view) => view.id)).toEqual([theirs])
    expect((await ctx.workflows.list(org)).map((view) => view.id)).toContain(runId)
    expect(await ctx.db.workflowSignal.count({ where: { organizationId: other } })).toBe(0)
    await ctx.workflows.cancel(approval, org, { runId })
    await ctx.workflows.cancel(approval, other, { runId: theirs })
  })

  it('leaves a run of a workflow this worker does not know for a worker that does, pushed back so it is not swept every tick', async () => {
    const { runId } = await ctx.workflows.start(pipeline, org, { base: 1 })
    const result = await ctx.queue.drain(ctx, buildJobs(workflows))
    expect(result.failed).toEqual([])
    expect(calls.get(runId)).toBeUndefined()
    expect(await run(runId)).toMatchObject({ status: 'running', currentStep: 'first', wakeAt: new Date(clock.getTime() + STEP_LEASE_MS) })
    expect(await sweepOnly([runId])).toEqual([])
    travel(STEP_LEASE_MS)
    await sweep()
    expect(await run(runId)).toMatchObject({ status: 'completed' })
  })

  it('does not let runs whose job finds nothing to do starve a due run, nor wake a run for a signal it does not wait for', async () => {
    const crowd = await createTestOrganization(ctx.db)
    try {
      // 500 runs of a workflow no worker knows, overdue and waiting (so never pushed back): each sweep finds them.
      await ctx.db.workflowRun.createMany({
        data: Array.from({ length: 500 }, (_, index) => ({
          organizationId: crowd,
          workflow: 'test.unregistered',
          key: `crowd-${index}`,
          status: 'waiting' as const,
          input: {},
          currentStep: 'wait',
          waitingFor: 'go',
          wakeAt: new Date(clock.getTime() - 3_600_000),
        })),
      })
      const { runId: due } = await ctx.workflows.start(pipeline, org, { base: 1 })
      ctx.queue.waiting.length = 0
      const { runId: waitingRun } = await ctx.workflows.start(approval, org, {})
      await drain()
      // A signal of another name (a duplicate webhook, a signal for a later step) does not make it due.
      await ctx.db.workflowSignal.create({ data: { organizationId: org, runId: waitingRun, name: 'unrelated', payload: {} } })

      await sweep()
      expect(calls.get(due)).toBeUndefined()
      await sweep()
      expect(calls.get(due)).toEqual(['first', 'flaky#1', 'last'])
      expect(await sweepOnly([waitingRun])).toEqual([])
      await ctx.workflows.cancel(approval, org, { runId: waitingRun })
    } finally {
      await ctx.db.organization.delete({ where: { id: crowd } })
    }
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
    expect(order.phase).toBe('new')

    const { runId } = await ctx.workflows.start(fulfil, org, { orderId: order.id }, { key: order.id })
    await drain()
    expect(await run(runId)).toMatchObject({ status: 'waiting', currentStep: 'label' })
    expect(fake.statusUpdates).toEqual([])

    await ctx.workflows.signal(fulfil, org, { key: order.id }, 'label.created', { trackingNumber: 'TRACK-1' })
    await drain()
    expect(await ctx.workflows.get(org, runId)).toMatchObject({ status: 'completed', results: { ship: { trackingNumber: 'TRACK-1' } } })
    expect((await ctx.db.order.findFirstOrThrow({ where: { id: order.id, organizationId: org } })).phase).toBe('shipped')
    expect(fake.statusUpdates).toContainEqual({ orderExternalId: 'fake-order-1', status: 'shipped' })
  })
})
