import type { WorkflowRunStatus } from '@hanza/db'
import type { AnyWorkflowDefinition } from './define'

/** How long a claimed step may run before the sweep assumes its worker died and runs it again. */
export const STEP_LEASE_MS = 10 * 60_000

export const MAX_ERROR_LENGTH = 1000

export const ACTIVE_STATUSES = ['running', 'sleeping', 'waiting'] as const satisfies readonly WorkflowRunStatus[]

export function isActive(status: WorkflowRunStatus): boolean {
  return (ACTIVE_STATUSES as readonly WorkflowRunStatus[]).includes(status)
}

export interface StepEntry {
  status: WorkflowRunStatus
  currentStep: string | null
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
  if (!next) return { status: 'completed', currentStep: null, wakeAt: null, finishedAt: args.now }
  switch (next.kind) {
    case 'run':
      return { status: 'running', currentStep: next.name, wakeAt: args.now, finishedAt: null }
    case 'sleep':
      return { status: 'sleeping', currentStep: next.name, wakeAt: next.until(args), finishedAt: null }
    case 'signal':
      return {
        status: 'waiting',
        currentStep: next.name,
        wakeAt: next.timeoutMs === null ? null : new Date(args.now.getTime() + next.timeoutMs),
        finishedAt: null,
      }
  }
}

export function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH)
}
