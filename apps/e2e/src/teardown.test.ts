import { describe, expect, it } from 'vitest'
import { StoppedError, Teardown } from './teardown'

const quiet = () => {}

describe('Teardown', () => {
  it('runs steps last-added first, once, and reports success', async () => {
    const order: string[] = []
    const teardown = new Teardown(quiet)
    teardown.add('database', async () => order.push('database'))
    teardown.add('processes', async () => order.push('processes'))
    const [first, second] = await Promise.all([teardown.run(), teardown.run()])
    expect(order).toEqual(['processes', 'database'])
    expect([first, second]).toEqual([true, true])
  })

  it('keeps going after a failed step and reports the failure', async () => {
    const order: string[] = []
    const teardown = new Teardown(quiet)
    teardown.add('database', async () => order.push('database'))
    teardown.add('processes', async () => {
      throw new Error('boom')
    })
    expect(await teardown.run()).toBe(false)
    expect(order).toEqual(['database'])
  })

  it('waits for the setup operation in flight, so a resource created meanwhile is removed too', async () => {
    const teardown = new Teardown(quiet)
    let created = false
    let removed = false
    let finishCreate!: () => void
    teardown.add('drop', async () => {
      removed = created
    })
    const setup = teardown.track(new Promise<void>((resolve) => (finishCreate = resolve)).then(() => void (created = true)))
    const done = teardown.run()
    finishCreate()
    await expect(setup).rejects.toBeInstanceOf(StoppedError)
    await done
    expect(removed).toBe(true)
  })

  it('interrupts a long wait at once instead of waiting for it', async () => {
    const teardown = new Teardown(quiet, 60_000)
    const flows = teardown.interruptible(new Promise<number>(() => {}))
    const started = Date.now()
    expect(await teardown.run()).toBe(true)
    await expect(flows).rejects.toBeInstanceOf(StoppedError)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('refuses new setup work once stopping, and runs a step added after it finished', async () => {
    const teardown = new Teardown(quiet)
    await teardown.run()
    await expect(teardown.track(Promise.resolve(1))).rejects.toBeInstanceOf(StoppedError)
    let ran = false
    teardown.add('late', async () => void (ran = true))
    await expect.poll(() => ran).toBe(true)
  })
})
