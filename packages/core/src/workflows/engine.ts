import type { Db, Prisma, WorkflowRun, WorkflowRunStatus } from '@hanza/db'
import type { z } from 'zod'
import { isUniqueViolation } from '../errors'
import type { Logger } from '../logger'
import type { JobQueue } from '../queue'
import type { AnyWorkflowDefinition } from './define'
import { enqueueAdvance } from './runner'
import { ACTIVE_STATUSES, enterStep } from './transitions'

/** A run, by the id `start` returned or by the caller's `key`. */
export type WorkflowTarget = { runId: string } | { key: string }

export type SignalName<TWorkflow extends AnyWorkflowDefinition> = keyof TWorkflow['signals'] & string

export type SignalPayload<TWorkflow extends AnyWorkflowDefinition, TSignal extends SignalName<TWorkflow>> =
  TWorkflow['signals'][TSignal] extends z.ZodType ? z.input<TWorkflow['signals'][TSignal]> : never

export interface WorkflowRunView {
  id: string
  workflow: string
  key: string | null
  status: WorkflowRunStatus
  input: unknown
  currentStep: string | null
  results: Record<string, unknown>
  /** Wake-up time while sleeping, timeout while waiting. */
  wakeAt: Date | null
  attempts: number
  lastError: string | null
  createdAt: Date
  updatedAt: Date
  finishedAt: Date | null
}

/**
 * The only workflow API callers see. The stage-1 engine keeps runs in Postgres and runs steps as jobs
 * (ADR 0012); a Temporal-backed engine can implement the same interface. Every method is scoped to
 * `organizationId`.
 */
export interface WorkflowEngine {
  /** Starts a run. With a `key`, at most one run per organization, workflow and key: a repeat returns it with `created: false`. */
  start<TWorkflow extends AnyWorkflowDefinition>(
    workflow: TWorkflow,
    organizationId: string,
    input: z.input<TWorkflow['input']>,
    options?: { key?: string },
  ): Promise<{ runId: string; created: boolean }>
  /** Sends a signal; it is kept until a wait step for it consumes it. A finished or unknown run is not signalled. */
  signal<TWorkflow extends AnyWorkflowDefinition, TSignal extends SignalName<TWorkflow>>(
    workflow: TWorkflow,
    organizationId: string,
    target: WorkflowTarget,
    signal: TSignal,
    payload: SignalPayload<TWorkflow, TSignal>,
  ): Promise<{ delivered: boolean }>
  /** Stops a run that has not finished; a step already running completes, but its result is discarded. */
  cancel(workflow: AnyWorkflowDefinition, organizationId: string, target: WorkflowTarget): Promise<{ cancelled: boolean }>
  get(organizationId: string, runId: string): Promise<WorkflowRunView | null>
  /** Latest first. */
  list(organizationId: string, options?: { take?: number }): Promise<WorkflowRunView[]>
}

function targetWhere(target: WorkflowTarget): { id: string } | { key: string } {
  return 'runId' in target ? { id: target.runId } : { key: target.key }
}

function toView(run: WorkflowRun): WorkflowRunView {
  return {
    id: run.id,
    workflow: run.workflow,
    key: run.key,
    status: run.status,
    input: run.input,
    currentStep: run.currentStep,
    results: (run.results ?? {}) as Record<string, unknown>,
    wakeAt: run.wakeAt,
    attempts: run.attempts,
    lastError: run.lastError,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt,
  }
}

/** The Postgres + `JobQueue` engine. */
export function createWorkflowEngine(deps: { db: Db; queue: JobQueue; log: Logger }): WorkflowEngine {
  const { db } = deps

  return {
    async start(workflow, organizationId, input, options = {}) {
      if (workflow.steps.length === 0) throw new Error(`Workflow "${workflow.name}" has no steps`)
      const parsed = workflow.input.parse(input) as unknown
      const now = new Date()
      const entry = enterStep(workflow, -1, { input: parsed, results: {}, now })
      let runId: string
      try {
        const run = await db.workflowRun.create({
          data: {
            organizationId,
            workflow: workflow.name,
            key: options.key ?? null,
            input: parsed as Prisma.InputJsonValue,
            results: {},
            ...entry,
          },
          select: { id: true },
        })
        runId = run.id
      } catch (error) {
        if (options.key === undefined || !isUniqueViolation(error)) throw error
        const existing = await db.workflowRun.findFirst({
          where: { organizationId, workflow: workflow.name, key: options.key },
          select: { id: true },
        })
        if (!existing) throw error
        return { runId: existing.id, created: false }
      }
      await enqueueAdvance(deps, { organizationId, runId }, entry, now)
      return { runId, created: true }
    },

    async signal(workflow, organizationId, target, signal, payload) {
      const schema = workflow.signals[signal] as z.ZodType | undefined
      if (!schema) throw new Error(`Workflow "${workflow.name}" has no signal "${signal}"`)
      const parsed = schema.parse(payload) as Prisma.InputJsonValue
      const run = await db.workflowRun.findFirst({
        where: { organizationId, workflow: workflow.name, ...targetWhere(target), status: { in: [...ACTIVE_STATUSES] } },
        select: { id: true },
      })
      if (!run) return { delivered: false }
      await db.workflowSignal.create({ data: { organizationId, runId: run.id, name: signal, payload: parsed } })
      // Also when not waiting yet: the run may have just entered its wait step and checked before this insert.
      await enqueueAdvance(deps, { organizationId, runId: run.id }, { status: 'waiting', wakeAt: null }, new Date())
      return { delivered: true }
    },

    async cancel(workflow, organizationId, target) {
      const cancelled = await db.workflowRun.updateMany({
        where: { organizationId, workflow: workflow.name, ...targetWhere(target), status: { in: [...ACTIVE_STATUSES] } },
        data: { status: 'cancelled', wakeAt: null, finishedAt: new Date(), version: { increment: 1 } },
      })
      return { cancelled: cancelled.count > 0 }
    },

    async get(organizationId, runId) {
      const run = await db.workflowRun.findFirst({ where: { id: runId, organizationId } })
      return run ? toView(run) : null
    },

    async list(organizationId, { take = 50 } = {}) {
      const runs = await db.workflowRun.findMany({
        where: { organizationId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take,
      })
      return runs.map(toView)
    },
  }
}
