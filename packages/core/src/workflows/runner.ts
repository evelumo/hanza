import type { Prisma, WorkflowRun, WorkflowRunStatus } from '@hanza/db'
import { afterCommit } from '../after-commit'
import type { Context } from '../context'
import { PermanentJobError, RetryLaterError, type JobRunInfo } from '../jobs'
import { TX_OPTIONS } from '../transaction'
import type { AnyWorkflowDefinition, WorkflowStep } from './define'
import { workflowCoalesceKeys, workflowStepRef } from './refs'
import { ACTIVE_STATUSES, enterStep, errorMessage, isActive, MAX_ERROR_LENGTH, STEP_LEASE_MS, type StepEntry } from './transitions'

/** Runs the sweep enqueues per tick at most; the rest are due on the next tick. */
export const SWEEP_BATCH = 500

const STATUS_OF_STEP: Record<WorkflowStep['kind'], WorkflowRunStatus> = { run: 'running', sleep: 'sleeping', signal: 'waiting' }

type Results = Record<string, unknown>

/** Thrown inside a transaction to roll it back when another worker or a cancel changed the run first. */
class LostRace extends Error {}

/**
 * Enqueues the job that advances a run in `entry`; a sleep is enqueued delayed until its wake-up time as a
 * hint. Best-effort after commit (ADR 0010): the sweep enqueues any run that is due, so a lost job only
 * delays it by a tick.
 */
export async function enqueueAdvance(
  ctx: Pick<Context, 'queue' | 'log'>,
  run: { organizationId: string; runId: string },
  entry: Pick<StepEntry, 'status' | 'wakeAt'>,
  now: Date,
): Promise<void> {
  if (!isActive(entry.status)) return
  const delayMs = entry.status === 'sleeping' && entry.wakeAt ? Math.max(0, entry.wakeAt.getTime() - now.getTime()) : 0
  await afterCommit(ctx, { job: workflowStepRef.name, organizationId: run.organizationId, runId: run.runId }, () =>
    ctx.queue.enqueue(workflowStepRef, run, {
      coalesceKey: workflowCoalesceKeys.step(run.runId),
      ...(delayMs > 0 ? { delayMs } : {}),
    }),
  )
}

/** Stores `results` and enters the step after `index`, unless the run changed since `version`. */
async function advance(
  db: Prisma.TransactionClient,
  definition: AnyWorkflowDefinition,
  run: WorkflowRun,
  version: number,
  index: number,
  input: unknown,
  results: Results,
): Promise<StepEntry | null> {
  const entry = enterStep(definition, index, { input, results, now: new Date() })
  const updated = await db.workflowRun.updateMany({
    where: { id: run.id, organizationId: run.organizationId, version },
    data: { ...entry, results: results as Prisma.InputJsonObject, attempts: 0, lastError: null, version: version + 1 },
  })
  return updated.count === 1 ? entry : null
}

async function fail(ctx: Context, run: WorkflowRun, version: number, reason: string): Promise<void> {
  await ctx.db.workflowRun.updateMany({
    where: { id: run.id, organizationId: run.organizationId, version },
    data: { status: 'failed', lastError: reason.slice(0, MAX_ERROR_LENGTH), wakeAt: null, finishedAt: new Date(), version: version + 1 },
  })
  ctx.log.error('workflow failed', { workflow: run.workflow, runId: run.id, organizationId: run.organizationId, step: run.currentStep ?? '' })
}

async function runStep(
  ctx: Context,
  definition: AnyWorkflowDefinition,
  run: WorkflowRun,
  index: number,
  step: Extract<WorkflowStep, { kind: 'run' }>,
  input: unknown,
  job: JobRunInfo,
): Promise<void> {
  // A lease held by another job: that job runs the step. Once it expires (its worker died), the step is claimable again.
  const claimedAt = new Date()
  if (run.wakeAt && run.wakeAt > claimedAt) return
  const claim = await ctx.db.workflowRun.updateMany({
    where: { id: run.id, organizationId: run.organizationId, version: run.version, status: 'running' },
    data: { wakeAt: new Date(claimedAt.getTime() + STEP_LEASE_MS), attempts: job.attempt, version: run.version + 1 },
  })
  // Another job claimed it first.
  if (claim.count === 0) return
  const version = run.version + 1
  const results = run.results as Results
  const release = (wakeAt: Date, error: unknown) =>
    ctx.db.workflowRun.updateMany({
      where: { id: run.id, organizationId: run.organizationId, version },
      data: { wakeAt, lastError: errorMessage(error) },
    })

  let result: unknown
  try {
    result = await step.run({
      ctx,
      organizationId: run.organizationId,
      runId: run.id,
      input,
      results,
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
    })
  } catch (error) {
    // The queue retries this job (with its backoff) or records it as failed. Releasing the lease lets the retry
    // claim the step; a sweep meanwhile is coalesced with the retry, which still holds the run's coalesce key.
    if (error instanceof RetryLaterError) await release(new Date(new Date().getTime() + error.delayMs), error)
    else if (error instanceof PermanentJobError || job.attempt >= job.maxAttempts) await fail(ctx, run, version, errorMessage(error))
    else await release(new Date(), error)
    throw error
  }

  const entry = await advance(ctx.db, definition, run, version, index, input, { ...results, [step.name]: result ?? null })
  // Cancelled or re-claimed after an expired lease while the step ran: its result is discarded.
  if (!entry) return
  await enqueueAdvance(ctx, { organizationId: run.organizationId, runId: run.id }, entry, new Date())
}

async function wakeUp(ctx: Context, definition: AnyWorkflowDefinition, run: WorkflowRun, index: number, input: unknown): Promise<void> {
  if (run.wakeAt && run.wakeAt > new Date()) return
  const entry = await advance(ctx.db, definition, run, run.version, index, input, run.results as Results)
  if (entry) await enqueueAdvance(ctx, { organizationId: run.organizationId, runId: run.id }, entry, new Date())
}

async function receiveSignal(
  ctx: Context,
  definition: AnyWorkflowDefinition,
  run: WorkflowRun,
  index: number,
  step: Extract<WorkflowStep, { kind: 'signal' }>,
  input: unknown,
): Promise<void> {
  const signal = await ctx.db.workflowSignal.findFirst({
    where: { organizationId: run.organizationId, runId: run.id, name: step.signal, consumedAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  if (!signal) {
    if (run.wakeAt && run.wakeAt <= new Date()) await fail(ctx, run, run.version, `Timed out waiting for signal "${step.signal}"`)
    return
  }
  const payload = step.payload.safeParse(signal.payload)
  if (!payload.success) return fail(ctx, run, run.version, `Signal "${step.signal}" no longer matches its schema: ${payload.error.message}`)

  let entry: StepEntry | null
  try {
    entry = await ctx.db.$transaction(async (tx) => {
      const consumed = await tx.workflowSignal.updateMany({
        where: { id: signal.id, organizationId: run.organizationId, consumedAt: null },
        data: { consumedAt: new Date() },
      })
      const advanced = await advance(tx, definition, run, run.version, index, input, { ...(run.results as Results), [step.name]: payload.data })
      if (consumed.count !== 1 || !advanced) throw new LostRace()
      return advanced
    }, TX_OPTIONS)
  } catch (error) {
    if (error instanceof LostRace) return
    throw error
  }
  await enqueueAdvance(ctx, { organizationId: run.organizationId, runId: run.id }, entry, new Date())
}

/**
 * The `workflow.step` job: moves a run on by at most one step. Safe to run any number of times and
 * concurrently: every change is guarded by the run's `version`.
 */
export async function advanceRun(
  ctx: Context,
  definitions: ReadonlyMap<string, AnyWorkflowDefinition>,
  target: { organizationId: string; runId: string },
  job: JobRunInfo,
): Promise<void> {
  const run = await ctx.db.workflowRun.findFirst({ where: { id: target.runId, organizationId: target.organizationId } })
  if (!run || !isActive(run.status)) return
  const definition = definitions.get(run.workflow)
  if (!definition) {
    // Left for a worker that knows the workflow, e.g. while a deploy rolls out; the sweep enqueues it again.
    ctx.log.info('workflow unknown to this worker', { workflow: run.workflow, runId: run.id })
    return
  }

  const index = definition.steps.findIndex((candidate) => candidate.name === run.currentStep)
  const step = definition.steps[index]
  if (!step || STATUS_OF_STEP[step.kind] !== run.status) {
    return fail(ctx, run, run.version, `Step "${run.currentStep}" of workflow "${run.workflow}" changed while the run was in it`)
  }
  const input = definition.input.safeParse(run.input)
  if (!input.success) return fail(ctx, run, run.version, `The input no longer matches workflow "${run.workflow}": ${input.error.message}`)

  switch (step.kind) {
    case 'run':
      return runStep(ctx, definition, run, index, step, input.data, job)
    case 'sleep':
      return wakeUp(ctx, definition, run, index, input.data)
    case 'signal':
      return receiveSignal(ctx, definition, run, index, step, input.data)
  }
}

/**
 * The `workflow.sweep` job: enqueues every run that is due, i.e. a step not yet run or whose lease expired,
 * a timer or timeout that passed, or a waiting run with a signal not consumed yet. Reads across
 * organizations (ids only), like `sync.tick` (ADR 0012).
 */
export async function sweepRuns(ctx: Context): Promise<number> {
  const due = await ctx.db.workflowRun.findMany({
    where: {
      OR: [
        { status: { in: [...ACTIVE_STATUSES] }, wakeAt: { lte: new Date() } },
        // A signal kept for a later wait step also matches; that run gets a no-op job each tick.
        { status: 'waiting', signals: { some: { consumedAt: null } } },
      ],
    },
    select: { id: true, organizationId: true },
    orderBy: { wakeAt: { sort: 'asc', nulls: 'first' } },
    take: SWEEP_BATCH,
  })
  for (const run of due) {
    await ctx.queue.enqueue(
      workflowStepRef,
      { organizationId: run.organizationId, runId: run.id },
      { coalesceKey: workflowCoalesceKeys.step(run.id) },
    )
  }
  return due.length
}
