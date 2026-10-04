import { describe, expect, it } from 'vitest'
import { afterCommit } from './after-commit'
import type { Context } from './context'

function recordingContext() {
  const errors: Array<{ message: string; fields?: Record<string, unknown> }> = []
  const ctx = { log: { info() {}, error: (message: string, fields?: Record<string, unknown>) => errors.push({ message, fields }) } }
  return { ctx: ctx as unknown as Context, errors }
}

describe('afterCommit', () => {
  it('swallows a failure and logs it with the given ids', async () => {
    const { ctx, errors } = recordingContext()
    await expect(
      afterCommit(ctx, { job: 'stock.push', organizationId: 'org-1', connectionId: 'c-1' }, async () => {
        throw new Error('Connection is closed.')
      }),
    ).resolves.toBeUndefined()
    expect(errors).toEqual([
      { message: 'post-commit step failed', fields: { job: 'stock.push', organizationId: 'org-1', connectionId: 'c-1', error: 'Connection is closed.' } },
    ])
  })

  it('logs nothing when the work succeeds', async () => {
    const { ctx, errors } = recordingContext()
    await afterCommit(ctx, { step: 'orders.rematch', organizationId: 'org-1' }, async () => 'done')
    expect(errors).toEqual([])
  })
})
