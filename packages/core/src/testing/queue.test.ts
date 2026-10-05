import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Context } from '../context'
import { defineJob, PermanentJobError, RetryLaterError, type JobDefinition } from '../jobs'
import { stockPushRef, syncTickRef } from '../jobs/refs'
import { createInMemoryJobQueue } from './queue'

const ctx = {} as Context

describe('createInMemoryJobQueue', () => {
  it('drops a request while a job with the same coalesceKey waits', async () => {
    const queue = createInMemoryJobQueue()
    const payload = { organizationId: 'o', connectionId: 'c' }
    await queue.enqueue(stockPushRef, payload, { coalesceKey: 'stock.push:c' })
    await queue.enqueue(stockPushRef, payload, { coalesceKey: 'stock.push:c' })
    await queue.enqueue(stockPushRef, { ...payload, connectionId: 'd' }, { coalesceKey: 'stock.push:d' })
    expect(queue.waiting.map((job) => job.payload)).toEqual([payload, { ...payload, connectionId: 'd' }])
  })

  it('validates payloads', async () => {
    await expect(createInMemoryJobQueue().enqueue(stockPushRef, { organizationId: '', connectionId: 'c' })).rejects.toThrow()
  })

  it('records schedules, one per schedule id', async () => {
    const queue = createInMemoryJobQueue()
    await queue.schedule('sync.tick', syncTickRef, {}, { everyMs: 1_000 })
    await queue.schedule('sync.tick', syncTickRef, {}, { everyMs: 60_000 })
    expect(queue.schedules).toEqual([{ scheduleId: 'sync.tick', name: 'sync.tick', payload: {}, everyMs: 60_000 }])
  })
})

describe('drain', () => {
  const schema = z.object({ key: z.string() })

  it('runs jobs FIFO, including the ones they enqueue, and lets a request made while running run after it', async () => {
    const queue = createInMemoryJobQueue()
    const ran: string[] = []
    const job: JobDefinition = defineJob({
      name: 'test.job',
      schema,
      async handler(_ctx, payload) {
        ran.push(payload.key)
        if (payload.key === 'a' && ran.length === 1) {
          // "a" is running, not waiting, so the same key is accepted again (and only once).
          await queue.enqueue(job, { key: 'a' }, { coalesceKey: 'a' })
          await queue.enqueue(job, { key: 'a' }, { coalesceKey: 'a' })
          await queue.enqueue(job, { key: 'c' })
        }
      },
    }) as JobDefinition
    await queue.enqueue(job, { key: 'a' }, { coalesceKey: 'a' })
    await queue.enqueue(job, { key: 'b' })
    expect(await queue.drain(ctx, [job])).toEqual({ ran: 4, failed: [] })
    expect(ran).toEqual(['a', 'b', 'a', 'c'])
    expect(queue.waiting).toEqual([])
  })

  it('retries ordinary errors up to 5 attempts, fails PermanentJobError at once, and re-queues RetryLaterError without an attempt', async () => {
    const queue = createInMemoryJobQueue()
    const attempts: Record<string, number[]> = { flaky: [], broken: [], permanent: [], later: [] }
    let laterRuns = 0
    const job = defineJob({
      name: 'test.job',
      schema,
      async handler(_ctx, { key }, run) {
        attempts[key]!.push(run.attempt)
        if (key === 'flaky' && run.attempt < 3) throw new Error('flaky')
        if (key === 'broken') throw new Error('broken')
        if (key === 'permanent') throw new PermanentJobError('permanent')
        if (key === 'later' && ++laterRuns < 3) throw new RetryLaterError(1_000, 'later')
      },
    }) as JobDefinition
    for (const key of ['later', 'flaky', 'broken', 'permanent']) await queue.enqueue(job, { key })

    const result = await queue.drain(ctx, [job])
    expect(attempts).toEqual({ flaky: [1, 2, 3], broken: [1, 2, 3, 4, 5], permanent: [1], later: [1, 1, 1] })
    expect(result.failed.map((failure) => [failure.payload, failure.attempts])).toEqual([
      [{ key: 'broken' }, 5],
      [{ key: 'permanent' }, 1],
    ])
    expect(queue.failed).toEqual(result.failed)
  })

  it('tells the handler how many RetryLaterError retries the current attempt had, starting again after a used attempt', async () => {
    const queue = createInMemoryJobQueue()
    const runs: Array<[number, number]> = []
    const job = defineJob({
      name: 'test.job',
      schema,
      async handler(_ctx, _payload, run) {
        runs.push([run.attempt, run.retriedLater])
        if (runs.length === 3) throw new Error('used an attempt')
        if (runs.length < 5) throw new RetryLaterError(1_000, 'rate limited')
      },
    }) as JobDefinition
    await queue.enqueue(job, { key: 'x' })
    expect(await queue.drain(ctx, [job])).toEqual({ ran: 5, failed: [] })
    expect(runs).toEqual([
      [1, 0],
      [1, 1],
      [1, 2],
      [2, 0],
      [2, 1],
    ])
  })

  it('stops after maxJobs handler runs', async () => {
    const queue = createInMemoryJobQueue()
    const job = defineJob({
      name: 'test.job',
      schema,
      async handler() {
        throw new RetryLaterError(1_000, 'rate limited')
      },
    }) as JobDefinition
    await queue.enqueue(job, { key: 'x' })
    expect(await queue.drain(ctx, [job], { maxJobs: 3 })).toEqual({ ran: 3, failed: [] })
    expect(queue.waiting).toHaveLength(1)
  })
})
