import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { defineWorkflow, type AnyWorkflowDefinition } from './define'
import type { WorkflowEngine } from './engine'
import { createWorkflowJobs } from './jobs'

const approval = z.object({ approvedBy: z.string() })

const example = defineWorkflow({ name: 'test.example', input: z.object({ orderId: z.string() }) })
  .step('first', async ({ input, results }) => {
    // @ts-expect-error a later step's result is not known yet
    void results.last
    return { seen: input.orderId }
  })
  .sleep('pause', 60_000)
  .waitForSignal('approved', 'order.approved', approval, { timeoutMs: 1_000 })
  .step('last', async ({ results }) => {
    expectTypeOf(results.first).toEqualTypeOf<{ seen: string }>()
    expectTypeOf(results.approved).toEqualTypeOf<{ approvedBy: string }>()
  })

describe('defineWorkflow', () => {
  it('keeps the steps in order with their kinds', () => {
    expect(example.name).toBe('test.example')
    expect(example.steps.map((step) => [step.name, step.kind])).toEqual([
      ['first', 'run'],
      ['pause', 'sleep'],
      ['approved', 'signal'],
      ['last', 'run'],
    ])
    expect(example.steps[2]).toMatchObject({ signal: 'order.approved', payload: approval, timeoutMs: 1_000 })
  })

  it('collects the signals with their payload schemas, typed for the engine', () => {
    expect(example.signals).toEqual({ 'order.approved': approval })
    expectTypeOf<keyof typeof example.signals>().toEqualTypeOf<'order.approved'>()
    expectTypeOf<z.input<(typeof example.signals)['order.approved']>>().toEqualTypeOf<{ approvedBy: string }>()
  })

  it('types the input, signal names and signal payloads for the engine', () => {
    const engine = {} as WorkflowEngine
    const calls = () => {
      void engine.start(example, 'org', { orderId: 'o-1' })
      void engine.signal(example, 'org', { runId: 'r' }, 'order.approved', { approvedBy: 'x' })
      // @ts-expect-error the input must match the schema
      void engine.start(example, 'org', { orderId: 1 })
      // @ts-expect-error not a signal of this workflow
      void engine.signal(example, 'org', { key: 'k' }, 'order.shipped', {})
      // @ts-expect-error the payload must match the signal's schema
      void engine.signal(example, 'org', { runId: 'r' }, 'order.approved', { approvedBy: 1 })
    }
    expect(calls).toBeTypeOf('function')
  })

  it('leaves the definition it extends unchanged', () => {
    const base = defineWorkflow({ name: 'test.base', input: z.object({}) })
    const extended = base.step('a', async () => null)
    expect(base.steps).toEqual([])
    expect(extended.steps).toHaveLength(1)
  })

  it('rejects a repeated step name and a signal declared with two schemas', () => {
    const base = defineWorkflow({ name: 'test.dupes', input: z.object({}) }).step('a', async () => null)
    expect(() => base.sleep('a', 1)).toThrow('already has a step "a"')
    const waiting = base.waitForSignal('b', 's', approval)
    expect(() => waiting.waitForSignal('c', 's', z.object({}))).toThrow('two payload schemas')
    expect(waiting.waitForSignal('c', 's', approval).steps).toHaveLength(3)
  })

  it('computes sleep wake-up times from a duration, a function returning ms, or a date', () => {
    const now = new Date('2026-10-05T12:00:00Z')
    const at = new Date('2026-10-08T00:00:00Z')
    const timers = defineWorkflow({ name: 'test.timers', input: z.object({ days: z.number() }) })
      .sleep('fixed', 5_000)
      .sleep('fromInput', ({ input }) => input.days * 86_400_000)
      .sleep('until', () => at)
    const until = timers.steps.map((step) => (step.kind === 'sleep' ? step.until({ input: { days: 2 }, results: {}, now }) : null))
    expect(until).toEqual([new Date('2026-10-05T12:00:05Z'), new Date('2026-10-07T12:00:00Z'), at])
  })

  it('stays assignable to AnyWorkflowDefinition', () => {
    const list: AnyWorkflowDefinition[] = [example]
    expect(list).toHaveLength(1)
  })
})

describe('createWorkflowJobs', () => {
  it('creates the step and sweep jobs and refuses a workflow registered twice', () => {
    expect(createWorkflowJobs([example]).map((job) => job.name)).toEqual(['workflow.step', 'workflow.sweep'])
    expect(() => createWorkflowJobs([example, example])).toThrow('registered twice')
  })
})
