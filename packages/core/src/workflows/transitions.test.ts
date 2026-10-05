import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineWorkflow } from './define'
import { enterStep, errorMessage, isActive, MAX_ERROR_LENGTH } from './transitions'

const now = new Date('2026-10-05T12:00:00Z')

const workflow = defineWorkflow({ name: 'test.transitions', input: z.object({}) })
  .step('first', async () => null)
  .sleep('pause', ({ results }) => (results.first === null ? 60_000 : 0))
  .waitForSignal('forever', 'go', z.object({}))
  .waitForSignal('bounded', 'stop', z.object({}), { timeoutMs: 3_600_000 })

const enter = (index: number) => enterStep(workflow, index, { input: {}, results: { first: null }, now })

describe('enterStep', () => {
  it('makes a step due at once', () => {
    expect(enter(-1)).toEqual({ status: 'running', currentStep: 'first', wakeAt: now, finishedAt: null })
  })

  it('sleeps until the time the sleep computes from the results so far', () => {
    expect(enter(0)).toEqual({ status: 'sleeping', currentStep: 'pause', wakeAt: new Date('2026-10-05T12:01:00Z'), finishedAt: null })
  })

  it('waits for good without a timeout, and until the timeout with one', () => {
    expect(enter(1)).toEqual({ status: 'waiting', currentStep: 'forever', wakeAt: null, finishedAt: null })
    expect(enter(2)).toEqual({ status: 'waiting', currentStep: 'bounded', wakeAt: new Date('2026-10-05T13:00:00Z'), finishedAt: null })
  })

  it('completes the run past the last step', () => {
    expect(enter(3)).toEqual({ status: 'completed', currentStep: null, wakeAt: null, finishedAt: now })
  })
})

describe('isActive', () => {
  it('is true until the run finished', () => {
    expect(['running', 'sleeping', 'waiting', 'completed', 'failed', 'cancelled'].map((status) => isActive(status as never))).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ])
  })
})

describe('errorMessage', () => {
  it('truncates long messages and stringifies non-errors', () => {
    expect(errorMessage(new Error('x'.repeat(5_000)))).toHaveLength(MAX_ERROR_LENGTH)
    expect(errorMessage('plain')).toBe('plain')
  })
})
