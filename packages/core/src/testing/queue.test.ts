import { describe, expect, it } from 'vitest'
import { stockPushRef } from '../jobs/refs'
import { createInMemoryJobQueue } from './queue'

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
})
