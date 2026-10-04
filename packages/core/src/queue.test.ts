import { DelayedError, UnrecoverableError } from 'bullmq'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { Context } from './context'
import { defineJob, PermanentJobError, RetryLaterError, type JobDefinition } from './jobs'
import { stockPushRef, syncTickRef } from './jobs/refs'
import { bullJobOptions, createJobProcessor, createJobQueue, redisConnection } from './queue'

const bull = vi.hoisted(() => ({ add: vi.fn(), upsertJobScheduler: vi.fn() }))

vi.mock('bullmq', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bullmq')>()
  class Queue {
    add = bull.add
    upsertJobScheduler = bull.upsertJobScheduler
    async close() {}
  }
  return { ...actual, Queue }
})

describe('redisConnection', () => {
  it('parses host, port, credentials and database', () => {
    expect(redisConnection('redis://user:p%40ss@redis.local:6390/2')).toMatchObject({
      host: 'redis.local',
      port: 6390,
      username: 'user',
      password: 'p@ss',
      db: 2,
      tls: undefined,
    })
  })

  it('defaults the port and enables TLS for rediss://', () => {
    expect(redisConnection('rediss://cache.example.com')).toMatchObject({
      host: 'cache.example.com',
      port: 6379,
      tls: {},
    })
  })
})

describe('bullJobOptions', () => {
  it('maps coalesceKey to deduplication that keeps the last request while one is active', () => {
    expect(bullJobOptions({ coalesceKey: 'stock.push:c1', delayMs: 500 })).toEqual({
      deduplication: { id: 'stock.push:c1', keepLastIfActive: true },
      delay: 500,
    })
  })

  it('adds nothing without options', () => {
    expect(bullJobOptions()).toEqual({})
  })
})

describe('createJobQueue', () => {
  it('passes the parsed payload and the coalescing options to Queue.add', async () => {
    const queue = createJobQueue('redis://localhost:6389')
    await queue.enqueue(stockPushRef, { organizationId: 'o', connectionId: 'c' }, { coalesceKey: 'stock.push:c' })
    expect(bull.add).toHaveBeenCalledWith(
      'stock.push',
      { organizationId: 'o', connectionId: 'c' },
      { deduplication: { id: 'stock.push:c', keepLastIfActive: true } },
    )
  })

  it('schedules through upsertJobScheduler, keyed by the schedule id', async () => {
    const queue = createJobQueue('redis://localhost:6389')
    await queue.schedule('sync.tick', syncTickRef, {}, { everyMs: 60_000 })
    expect(bull.upsertJobScheduler).toHaveBeenCalledWith('sync.tick', { every: 60_000 }, { name: 'sync.tick', data: {} })
  })

  it('rejects an invalid payload before it reaches Redis', async () => {
    bull.add.mockClear()
    await expect(createJobQueue('redis://localhost:6389').enqueue(stockPushRef, { organizationId: '', connectionId: 'c' })).rejects.toThrow()
    expect(bull.add).not.toHaveBeenCalled()
  })
})

describe('createJobProcessor', () => {
  const ctx = { log: { info() {}, error() {} } } as unknown as Context
  const handler = vi.fn<JobDefinition['handler']>()
  const job = defineJob({ name: 'test.job', schema: z.object({ organizationId: z.string().min(1) }), handler }) as JobDefinition
  const process = createJobProcessor(ctx, [job])
  const bullJob = (overrides: Partial<{ name: string; data: unknown; attemptsMade: number }> = {}) => ({
    id: '1',
    name: 'test.job',
    data: { organizationId: 'o' },
    attemptsMade: 2,
    opts: { attempts: 5 },
    moveToDelayed: vi.fn(async () => {}),
    ...overrides,
  })

  it('runs the handler with the parsed payload and 1-based run info', async () => {
    handler.mockResolvedValueOnce()
    await process(bullJob())
    expect(handler).toHaveBeenLastCalledWith(ctx, { organizationId: 'o' }, { attempt: 3, maxAttempts: 5 })
  })

  it('moves the job to delayed on RetryLaterError, without using an attempt', async () => {
    handler.mockRejectedValueOnce(new RetryLaterError(5_000, 'rate limited'))
    const target = bullJob()
    const before = Date.now()
    await expect(process(target, 'token-1')).rejects.toBeInstanceOf(DelayedError)
    expect(target.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'token-1')
    const [timestamp] = target.moveToDelayed.mock.calls[0] as unknown as [number]
    expect(timestamp).toBeGreaterThanOrEqual(before + 5_000)
  })

  it('maps PermanentJobError to UnrecoverableError and rethrows anything else', async () => {
    handler.mockRejectedValueOnce(new PermanentJobError('auth expired'))
    await expect(process(bullJob())).rejects.toThrow(UnrecoverableError)
    const boom = new Error('boom')
    handler.mockRejectedValueOnce(boom)
    await expect(process(bullJob())).rejects.toBe(boom)
  })

  it('fails unknown jobs and invalid payloads without retrying', async () => {
    await expect(process(bullJob({ name: 'nope' }))).rejects.toThrow(UnrecoverableError)
    await expect(process(bullJob({ data: { organizationId: '' } }))).rejects.toThrow(UnrecoverableError)
  })
})
