import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineWorkflow } from './define'
import { enterStep, isActive, MAX_JSON_BYTES, stepTag, storableValue, toJson, WorkflowValueError } from './transitions'

const now = new Date('2026-10-05T12:00:00Z')

const workflow = defineWorkflow({ name: 'test.transitions', input: z.object({}) })
  .step('first', async () => null)
  .sleep('pause', ({ results }) => (results.first === null ? 60_000 : 0))
  .waitForSignal('forever', 'go', z.object({}))
  .waitForSignal('bounded', 'stop', z.object({}), { timeoutMs: 3_600_000 })

const enter = (index: number) => enterStep(workflow, index, { input: {}, results: { first: null }, now })

describe('enterStep', () => {
  it('makes a step due at once', () => {
    expect(enter(-1)).toEqual({ status: 'running', currentStep: 'first', waitingFor: null, wakeAt: now, finishedAt: null })
  })

  it('sleeps until the time the sleep computes from the results so far', () => {
    expect(enter(0)).toMatchObject({ status: 'sleeping', currentStep: 'pause', waitingFor: null, wakeAt: new Date('2026-10-05T12:01:00Z') })
  })

  it('waits for its signal, for good without a timeout and until the timeout with one', () => {
    expect(enter(1)).toEqual({ status: 'waiting', currentStep: 'forever', waitingFor: 'go', wakeAt: null, finishedAt: null })
    expect(enter(2)).toEqual({ status: 'waiting', currentStep: 'bounded', waitingFor: 'stop', wakeAt: new Date('2026-10-05T13:00:00Z'), finishedAt: null })
  })

  it('completes the run past the last step', () => {
    expect(enter(3)).toEqual({ status: 'completed', currentStep: null, waitingFor: null, wakeAt: null, finishedAt: now })
  })
})

describe('isActive and stepTag', () => {
  it('is active until the run finished', () => {
    expect(['running', 'sleeping', 'waiting', 'completed', 'failed', 'cancelled'].map((status) => isActive(status as never))).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ])
  })

  it('tags a step by kind and name', () => {
    expect(workflow.steps.map(stepTag)).toEqual(['run:first', 'sleep:pause', 'signal:forever', 'signal:bounded'])
  })
})

describe('storableValue', () => {
  it('stores the value as given and returns what the worker will parse from it', () => {
    const schema = z.object({ count: z.string().transform(Number), at: z.string().transform((value) => new Date(value)) })
    const { json, parsed } = storableValue(schema, { count: '3', at: '2026-10-05T12:00:00Z' }, 'The input')
    expect(json).toEqual({ count: '3', at: '2026-10-05T12:00:00Z' })
    expect(parsed).toEqual({ count: 3, at: now })
  })

  it('refuses a value that does not read back the same from JSON', () => {
    expect(() => storableValue(z.object({ at: z.date() }), { at: now }, 'The input')).toThrow(WorkflowValueError)
    expect(() => storableValue(z.object({ n: z.number().optional() }), { n: Number.NaN }, 'The input')).toThrow()
    expect(() => storableValue(z.any(), { big: 1n }, 'The input')).toThrow('is not JSON')
  })

  it('passes on the schema error for an invalid value', () => {
    expect(() => storableValue(z.object({ id: z.string() }), { id: 1 }, 'The input')).toThrow(z.ZodError)
  })
})

describe('toJson', () => {
  it('refuses values over the size limit', () => {
    expect(toJson({ text: 'x'.repeat(100) }, 'The result')).toEqual({ text: 'x'.repeat(100) })
    expect(() => toJson('x'.repeat(MAX_JSON_BYTES), 'The result')).toThrow('larger than 256 KB')
  })
})
