import { setTimeout as sleep } from 'node:timers/promises'

/** Thrown into the setup when teardown has started (a signal arrived) so it creates nothing more. */
export class StoppedError extends Error {
  constructor() {
    super('stopped')
  }
}

interface Step {
  name: string
  run: () => Promise<unknown>
}

/**
 * Teardown steps, run last-added first, once. A step is added before the resource it removes is
 * created, and `track` makes teardown wait for the setup operation in flight (a database being
 * created, a service starting), so a signal at any moment of the setup still removes everything.
 */
export class Teardown {
  private readonly steps: Step[] = []
  private inFlight: Promise<unknown> = Promise.resolve()
  private draining: Promise<boolean> | undefined
  private finished = false
  private failed = false
  private readonly stopped: Promise<never>
  private stop!: (error: StoppedError) => void

  constructor(
    private readonly log: (message: string) => void,
    private readonly settleTimeoutMs = 60_000,
  ) {
    this.stopped = new Promise<never>((_, reject) => (this.stop = reject))
    this.stopped.catch(() => {})
  }

  get stopping(): boolean {
    return this.draining !== undefined
  }

  add(name: string, run: () => Promise<unknown>): void {
    const step = { name, run }
    // Added after teardown finished (cannot happen with `track`, but must not leak): run it now.
    if (this.finished) void this.runStep(step)
    else this.steps.push(step)
  }

  /**
   * Awaits a wait that creates nothing (a build, readiness, the flows): rejects with StoppedError
   * as soon as teardown starts, which then stops the processes behind it right away.
   */
  async interruptible<T>(wait: Promise<T>): Promise<T> {
    if (this.stopping) throw new StoppedError()
    return Promise.race([wait, this.stopped])
  }

  /**
   * Awaits an operation that creates something (a database, a run record): teardown lets it
   * finish first, so what it created is removed too; throws StoppedError when teardown started meanwhile.
   */
  async track<T>(operation: Promise<T>): Promise<T> {
    if (this.stopping) throw new StoppedError()
    this.inFlight = operation.then(
      () => undefined,
      () => undefined,
    )
    const value = await operation
    if (this.stopping) throw new StoppedError()
    return value
  }

  /** Runs every step (also ones added while it runs); resolves true when all succeeded. Idempotent. */
  run(): Promise<boolean> {
    this.draining ??= (async () => {
      this.stop(new StoppedError())
      await Promise.race([this.inFlight, sleep(this.settleTimeoutMs)])
      for (let step = this.steps.pop(); step; step = this.steps.pop()) await this.runStep(step)
      this.finished = true
      return !this.failed
    })()
    return this.draining
  }

  private async runStep(step: Step): Promise<void> {
    const started = Date.now()
    try {
      await step.run()
      this.log(`teardown: ${step.name} (${((Date.now() - started) / 1000).toFixed(1)} s)`)
    } catch (error) {
      this.failed = true
      this.log(`teardown: ${step.name} FAILED: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
