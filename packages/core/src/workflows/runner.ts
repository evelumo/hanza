import { randomUUID } from 'node:crypto'
import { Prisma, type WorkflowRun } from '@hanza/db'
import { afterCommit } from '../after-commit'
import type { Context } from '../context'
import { PermanentJobError, RetryLaterError } from '../jobs'
import { describeFailure } from '../describe-failure'
import { TX_OPTIONS } from '../transaction'
import type { AnyWorkflowDefinition, WorkflowStep } from './define'
import { workflowCoalesceKeys, workflowStepRef } from './refs'
import {
  enterStep,
  isActive,
  MAX_STEP_ATTEMPTS,
  STATUS_OF_STEP,
  STEP_LEASE_MS,
  stepTag,
  toJson,
  type StepEntry,
} from './transitions'

/** Runs the sweep enqueues per tick at most, least recently swept first; the rest follow on later ticks. */
export const SWEEP_BATCH = 500

type Results = Record<string, unknown>

/** Thrown inside a transaction to roll it back when another job or a cancel moved the run first. */
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

/**
 * Matches the run only while it is still in the state it was read in. Claims do not bump `version`, so
 * every execution of a step holds the same guard and the first one to finish commits.
 */
function unchanged(run: WorkflowRun) {
  return { id: run.id, organizationId: run.organizationId, version: run.version, status: run.status, currentStep: run.currentStep }
}

/** Records `step` as done with `results` and enters the step after it, unless the run moved on meanwhile. */
async function advance(
  db: Prisma.TransactionClient,
  definition: AnyWorkflowDefinition,
  run: WorkflowRun,
  index: number,
  step: WorkflowStep,
  input: unknown,
  results: Results,
): Promise<StepEntry | null> {
  const entry = enterStep(definition, index, { input, results, now: new Date() })
  const updated = await db.workflowRun.updateMany({
    where: unchanged(run),
    data: {
      ...entry,
      completedSteps: [...run.completedSteps, stepTag(step)],
      results: results as Prisma.InputJsonObject,
      attempts: 0,
      claimToken: null,
      lastError: null,
      version: run.version + 1,
    },
  })
  return updated.count === 1 ? entry : null
}

/** `holding` narrows the guard, e.g. to the execution that still holds the claim. */
async function fail(ctx: Context, run: WorkflowRun, reason: string, holding: Prisma.WorkflowRunWhereInput = {}): Promise<boolean> {
  const failed = await ctx.db.workflowRun.updateMany({
    where: { ...holding, ...unchanged(run) },
    data: {
      status: 'failed',
      lastError: reason,
      waitingFor: null,
      wakeAt: null,
      claimToken: null,
      finishedAt: new Date(),
      version: run.version + 1,
    },
  })
  if (failed.count === 0) return false
  ctx.log.error('workflow failed', { workflow: run.workflow, runId: run.id, organizationId: run.organizationId, step: run.currentStep ?? '' })
  return true
}

async function runStep(
  ctx: Context,
  definition: AnyWorkflowDefinition,
  run: WorkflowRun,
  index: number,
  step: Extract<WorkflowStep, { kind: 'run' }>,
  input: unknown,
): Promise<void> {
  const claimedAt = new Date()
  // A lease held by another execution, or a RetryLaterError delay that has not passed.
  if (run.wakeAt && run.wakeAt > claimedAt) return
  if (run.attempts >= MAX_STEP_ATTEMPTS) {
    // Every attempt so far was claimed and none finished or threw: its worker died or hung.
    await fail(ctx, run, `Step "${step.name}" did not finish in ${MAX_STEP_ATTEMPTS} attempts`, {
      attempts: { gte: MAX_STEP_ATTEMPTS },
      wakeAt: { lte: claimedAt },
    })
    return
  }
  // Atomic: of concurrent jobs only one passes the conditions, and the attempt count it read is still current.
  const claimToken = randomUUID()
  const claim = await ctx.db.workflowRun.updateMany({
    where: { ...unchanged(run), wakeAt: { lte: claimedAt }, attempts: run.attempts },
    data: { wakeAt: new Date(claimedAt.getTime() + STEP_LEASE_MS), attempts: run.attempts + 1, claimToken },
  })
  if (claim.count === 0) return
  const attempt = run.attempts + 1
  // An execution whose lease expired and was claimed again must not touch the newer execution's state:
  // its error is only logged.
  const holdingClaim = { ...unchanged(run), claimToken }
  const lostClaim = (error: unknown) =>
    ctx.log.info('workflow step error after its claim was taken over', {
      workflow: run.workflow,
      runId: run.id,
      step: step.name,
      error: describeFailure(error),
    })
  const results = run.results as Results

  let result: unknown
  try {
    result = await step.run({
      ctx,
      organizationId: run.organizationId,
      runId: run.id,
      input,
      results,
      attempt,
      maxAttempts: MAX_STEP_ATTEMPTS,
    })
  } catch (error) {
    const description = describeFailure(error)
    if (error instanceof PermanentJobError || (!(error instanceof RetryLaterError) && attempt >= MAX_STEP_ATTEMPTS)) {
      if (!(await fail(ctx, run, description, { claimToken }))) return lostClaim(error)
      throw error instanceof PermanentJobError ? error : new PermanentJobError(description)
    }
    const released = await ctx.db.workflowRun.updateMany({
      where: holdingClaim,
      // RetryLaterError, like the queue, uses no attempt. Otherwise releasing the lease lets the queue's
      // retry claim the step; a sweep meanwhile is coalesced with that retry.
      data:
        error instanceof RetryLaterError
          ? { wakeAt: new Date(new Date().getTime() + error.delayMs), attempts: attempt - 1, claimToken: null, lastError: description }
          : { wakeAt: new Date(), claimToken: null, lastError: description },
    })
    if (released.count === 0) return lostClaim(error)
    throw error
  }

  let stored: unknown
  try {
    stored = toJson(result ?? null, `The result of step "${step.name}"`)
  } catch (error) {
    await fail(ctx, run, describeFailure(error))
    throw new PermanentJobError(describeFailure(error))
  }
  const entry = await advance(ctx.db, definition, run, index, step, input, { ...results, [step.name]: stored })
  // Another execution of this step finished first, or the run was cancelled: this result is discarded.
  if (!entry) return
  await enqueueAdvance(ctx, { organizationId: run.organizationId, runId: run.id }, entry, new Date())
}

async function wakeUp(ctx: Context, definition: AnyWorkflowDefinition, run: WorkflowRun, index: number, step: WorkflowStep, input: unknown) {
  if (run.wakeAt && run.wakeAt > new Date()) return
  const entry = await advance(ctx.db, definition, run, index, step, input, run.results as Results)
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
    if (run.wakeAt && run.wakeAt <= new Date()) await fail(ctx, run, `Timed out waiting for signal "${step.signal}"`)
    return
  }
  const payload = step.payload.safeParse(signal.payload)
  if (!payload.success) {
    await fail(ctx, run, `Signal "${step.signal}" no longer matches its schema`)
    return
  }

  let entry: StepEntry | null
  try {
    entry = await ctx.db.$transaction(async (tx) => {
      const consumed = await tx.workflowSignal.updateMany({
        where: { id: signal.id, organizationId: run.organizationId, consumedAt: null },
        data: { consumedAt: new Date() },
      })
      const advanced = await advance(tx, definition, run, index, step, input, { ...(run.results as Results), [step.name]: payload.data })
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
 * concurrently: a step is claimed atomically and its result committed only if the run has not moved on.
 * Attempts are counted on the run, not taken from the queue.
 */
export async function advanceRun(
  ctx: Context,
  definitions: ReadonlyMap<string, AnyWorkflowDefinition>,
  target: { organizationId: string; runId: string },
): Promise<void> {
  const run = await ctx.db.workflowRun.findFirst({ where: { id: target.runId, organizationId: target.organizationId } })
  if (!run || !isActive(run.status)) return
  const definition = definitions.get(run.workflow)
  if (!definition) {
    // Left for a worker that knows the workflow (a deploy rolling out). Pushed back by a lease so the sweep
    // does not pick it up every tick; a waiting run keeps its timeout.
    const now = new Date()
    if (run.status !== 'waiting' && run.wakeAt && run.wakeAt <= now) {
      await ctx.db.workflowRun.updateMany({ where: unchanged(run), data: { wakeAt: new Date(now.getTime() + STEP_LEASE_MS) } })
    }
    ctx.log.info('workflow unknown to this worker', { workflow: run.workflow, runId: run.id })
    return
  }

  // The steps done so far must still be the definition's first steps, in order, and the current step next:
  // otherwise a reordered or inserted step would run twice or be skipped (versioning: issue #43).
  const index = run.completedSteps.length
  const step = definition.steps[index]
  const prefixMatches = run.completedSteps.every((tag, position) => {
    const done = definition.steps[position]
    return done !== undefined && stepTag(done) === tag
  })
  if (!prefixMatches || !step || step.name !== run.currentStep || STATUS_OF_STEP[step.kind] !== run.status) {
    await fail(ctx, run, `Workflow "${run.workflow}" changed while the run was in step "${run.currentStep}": its steps no longer match the steps already done`)
    return
  }
  const input = definition.input.safeParse(run.input)
  if (!input.success) {
    await fail(ctx, run, `The input no longer matches workflow "${run.workflow}"`)
    return
  }

  switch (step.kind) {
    case 'run':
      return runStep(ctx, definition, run, index, step, input.data)
    case 'sleep':
      return wakeUp(ctx, definition, run, index, step, input.data)
    case 'signal':
      return receiveSignal(ctx, definition, run, index, step, input.data)
  }
}

/**
 * The `workflow.sweep` job: enqueues every run that is due, i.e. a step not yet run or whose lease expired,
 * a timer or timeout that passed, or a waiting run with an unconsumed signal of the name it waits for.
 * Least recently swept first, so runs whose job finds nothing to do cannot starve the others. Reads across
 * organizations (ids only), like `sync.tick` (ADR 0014).
 */
export async function sweepRuns(ctx: Context): Promise<number> {
  const now = new Date()
  // Timestamps are stored as UTC without a zone; comparing in UTC keeps the session time zone out of it.
  const nowUtc = Prisma.sql`(to_timestamp(${now.getTime()}::double precision / 1000) AT TIME ZONE 'UTC')`
  const due = await ctx.db.$queryRaw<Array<{ id: string; organizationId: string }>>`
    SELECT r."id", r."organizationId"
    FROM "workflow_run" r
    WHERE (r."status" IN ('running', 'sleeping', 'waiting') AND r."wakeAt" <= ${nowUtc})
       OR (r."status" = 'waiting' AND EXISTS (
         SELECT 1 FROM "workflow_signal" s
         WHERE s."organizationId" = r."organizationId" AND s."runId" = r."id"
           AND s."name" = r."waitingFor" AND s."consumedAt" IS NULL))
    ORDER BY r."sweptAt" ASC NULLS FIRST, r."wakeAt" ASC NULLS LAST, r."id"
    LIMIT ${SWEEP_BATCH}`
  if (due.length === 0) return 0
  await ctx.db.workflowRun.updateMany({ where: { id: { in: due.map((run) => run.id) } }, data: { sweptAt: now } })
  for (const run of due) {
    await ctx.queue.enqueue(
      workflowStepRef,
      { organizationId: run.organizationId, runId: run.id },
      { coalesceKey: workflowCoalesceKeys.step(run.id) },
    )
  }
  return due.length
}
