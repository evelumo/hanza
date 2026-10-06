import { isDeepStrictEqual } from 'node:util'
import type { WorkflowRunStatus as DbWorkflowRunStatus } from '@hanza/db'
import type { z } from 'zod'
import type { AnyWorkflowDefinition, WorkflowStep } from './define'

/** Engine-neutral, so `WorkflowEngine` does not expose a Prisma type. */
export type WorkflowRunStatus = 'running' | 'sleeping' | 'waiting' | 'completed' | 'failed' | 'cancelled'

// Fails to compile when the database enum and the union drift apart.
const STATUSES_MATCH: [DbWorkflowRunStatus, WorkflowRunStatus] extends [WorkflowRunStatus, DbWorkflowRunStatus] ? true : never = true
void STATUSES_MATCH

/** How long a claimed step may run before the sweep assumes its worker died and runs it again. */
export const STEP_LEASE_MS = 10 * 60_000

/** Executions of one step (claims) before the run fails, including executions whose worker died. */
export const MAX_STEP_ATTEMPTS = 5

/** Largest input, signal payload or step result, as JSON. */
export const MAX_JSON_BYTES = 256 * 1024

export const ACTIVE_STATUSES = ['running', 'sleeping', 'waiting'] as const satisfies readonly WorkflowRunStatus[]

export function isActive(status: WorkflowRunStatus): boolean {
  return (ACTIVE_STATUSES as readonly WorkflowRunStatus[]).includes(status)
}

export const STATUS_OF_STEP: Record<WorkflowStep['kind'], WorkflowRunStatus> = { run: 'running', sleep: 'sleeping', signal: 'waiting' }

/** How a done step is recorded on the run, to check that a changed definition still starts with it. */
export function stepTag(step: WorkflowStep): string {
  return `${step.kind}:${step.name}`
}

export interface StepEntry {
  status: WorkflowRunStatus
  currentStep: string | null
  waitingFor: string | null
  wakeAt: Date | null
  finishedAt: Date | null
}

/**
 * The state of a run entering the step after `index` (-1 enters the first step): a step is due at once,
 * a sleep until its time, a wait until its timeout or for good; past the last step the run is completed.
 */
export function enterStep(
  definition: AnyWorkflowDefinition,
  index: number,
  args: { input: unknown; results: Record<string, unknown>; now: Date },
): StepEntry {
  const next = definition.steps[index + 1]
  if (!next) return { status: 'completed', currentStep: null, waitingFor: null, wakeAt: null, finishedAt: args.now }
  switch (next.kind) {
    case 'run':
      return { status: 'running', currentStep: next.name, waitingFor: null, wakeAt: args.now, finishedAt: null }
    case 'sleep':
      return { status: 'sleeping', currentStep: next.name, waitingFor: null, wakeAt: next.until(args), finishedAt: null }
    case 'signal':
      return {
        status: 'waiting',
        currentStep: next.name,
        waitingFor: next.signal,
        wakeAt: next.timeoutMs === null ? null : new Date(args.now.getTime() + next.timeoutMs),
        finishedAt: null,
      }
  }
}

/** Rejected by `start` or `signal`: the caller gets the error, instead of a run that fails later. */
export class WorkflowValueError extends Error {
  override readonly name = 'WorkflowValueError'
}

/** The value as JSON, or an error naming `what` when it is not JSON or larger than `MAX_JSON_BYTES`. */
export function toJson(value: unknown, what: string): unknown {
  let text: string | undefined
  try {
    text = JSON.stringify(value)
  } catch (error) {
    throw new WorkflowValueError(`${what} is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (text === undefined) throw new WorkflowValueError(`${what} is not JSON`)
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new WorkflowValueError(`${what} is larger than ${MAX_JSON_BYTES / 1024} KB as JSON`)
  return JSON.parse(text) as unknown
}

/**
 * Validates `value` the way the worker will read it back: the JSON stored must parse with `schema` to
 * the same value as `value` itself. `z.date()` or a value that changes in JSON is refused here.
 * Returns the JSON to store and its parsed value.
 */
export function storableValue(schema: z.ZodType, value: unknown, what: string): { json: unknown; parsed: unknown } {
  const direct = schema.parse(value)
  const json = toJson(value, what)
  const stored = schema.safeParse(json)
  if (!stored.success || !isDeepStrictEqual(stored.data, direct)) {
    throw new WorkflowValueError(`${what} does not read back the same from JSON; use JSON types in its schema (no dates, maps or undefined)`)
  }
  return { json, parsed: stored.data }
}
