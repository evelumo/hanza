import type { z } from 'zod'
import type { Context } from '../context'

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** What a step's `run` receives. */
export interface StepArgs<TInput, TResults> {
  ctx: Context
  organizationId: string
  runId: string
  input: TInput
  /** Results of the steps before this one, by step name. */
  results: TResults
  /**
   * 1-based count of executions of this step, including ones whose worker died; a throwing step is retried
   * up to `maxAttempts`, then the run fails.
   */
  attempt: number
  maxAttempts: number
}

/** What a sleep's duration function receives; `now` is when the sleep starts. */
export interface TimerArgs<TInput, TResults> {
  input: TInput
  results: TResults
  now: Date
}

// Steps are stored type-erased; the builder methods keep the types.
export type WorkflowStep =
  | { kind: 'run'; name: string; run: (args: StepArgs<any, any>) => Promise<unknown> }
  | { kind: 'sleep'; name: string; until: (args: TimerArgs<any, any>) => Date }
  | { kind: 'signal'; name: string; signal: string; payload: z.ZodType; timeoutMs: number | null }

type EmptyRecord = Record<never, never>
type StepResult<T> = [T] extends [void] ? null : T

/**
 * A linear list of named steps. Each method returns a new definition, so the result types of earlier
 * steps are known to later ones. Inputs, results and signal payloads are stored as JSON: like Event
 * payloads they hold ids, never credentials or Buyer personal data.
 */
export interface WorkflowDefinition<
  TInputSchema extends z.ZodType = z.ZodType,
  TResults extends Record<string, unknown> = EmptyRecord,
  TSignals extends Record<string, z.ZodType> = EmptyRecord,
> {
  readonly name: string
  readonly input: TInputSchema
  readonly steps: readonly WorkflowStep[]
  /** Payload schema of every signal a wait step of this workflow accepts. */
  readonly signals: TSignals

  /**
   * Runs `run` as a job, at least once: it runs again after a crash, and a step still running when its
   * 10-minute lease expires is started again beside it. Its effects must therefore be idempotent
   * (deterministic ids, unique keys, read-then-write guards). The first execution to finish commits the
   * result; later ones are discarded. The result must be JSON, at most 256 KB.
   */
  step<TName extends string, TResult extends JsonValue | void>(
    name: TName,
    run: (args: StepArgs<z.infer<TInputSchema>, TResults>) => Promise<TResult>,
  ): WorkflowDefinition<TInputSchema, TResults & { [K in TName]: StepResult<TResult> }, TSignals>

  /** A durable timer: `duration` in ms from when the sleep starts, or a function returning the time or ms. */
  sleep(
    name: string,
    duration: number | ((args: TimerArgs<z.infer<TInputSchema>, TResults>) => Date | number),
  ): WorkflowDefinition<TInputSchema, TResults, TSignals>

  /**
   * Waits for `signal`; its payload becomes the step's result. A signal sent earlier is kept until a wait
   * step consumes it, one signal per wait step: a signal sent twice is also consumed by a later wait step
   * of the same name. When `timeoutMs` passes first, the run fails.
   */
  waitForSignal<TName extends string, TSignal extends string, TPayload extends z.ZodType>(
    name: TName,
    signal: TSignal,
    payload: TPayload,
    options?: { timeoutMs?: number },
  ): WorkflowDefinition<TInputSchema, TResults & { [K in TName]: z.infer<TPayload> }, TSignals & { [K in TSignal]: TPayload }>
}

// `any` keeps every definition assignable, whatever its input, results and signals.
export type AnyWorkflowDefinition = WorkflowDefinition<any, any, any>

function build(name: string, input: z.ZodType, steps: readonly WorkflowStep[], signals: Record<string, z.ZodType>): AnyWorkflowDefinition {
  const add = (step: WorkflowStep, nextSignals = signals) => {
    if (steps.some((existing) => existing.name === step.name)) throw new Error(`Workflow "${name}" already has a step "${step.name}"`)
    return build(name, input, [...steps, step], nextSignals)
  }
  return {
    name,
    input,
    steps,
    signals,
    step: (stepName, run) => add({ kind: 'run', name: stepName, run }),
    sleep: (stepName, duration) =>
      add({
        kind: 'sleep',
        name: stepName,
        until: (args) => {
          const end = typeof duration === 'number' ? duration : duration(args)
          return typeof end === 'number' ? new Date(args.now.getTime() + end) : end
        },
      }),
    waitForSignal: (stepName, signal, payload, options = {}) => {
      const declared = signals[signal]
      if (declared && declared !== payload) throw new Error(`Workflow "${name}" declares signal "${signal}" with two payload schemas`)
      return add(
        { kind: 'signal', name: stepName, signal, payload, timeoutMs: options.timeoutMs ?? null },
        { ...signals, [signal]: payload },
      )
    },
  }
}

/**
 * Declares a workflow: `defineWorkflow({ name, input }).step(...).sleep(...).waitForSignal(...)`.
 * Start it with `ctx.workflows.start`; register it in `registry.ts` so the worker can run it.
 */
export function defineWorkflow<TInputSchema extends z.ZodType>(workflow: { name: string; input: TInputSchema }): WorkflowDefinition<TInputSchema> {
  return build(workflow.name, workflow.input, [], {}) as WorkflowDefinition<TInputSchema>
}
