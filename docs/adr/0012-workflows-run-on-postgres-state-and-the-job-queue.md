# Durable workflows run on Postgres state and the job queue, shaped so Temporal can replace them

Status: accepted (issue #8)

The automations stage needs processes that span days and several systems (order → label → invoice), and they must survive a worker crash or a lost Redis between steps. Temporal does this, but it is a new production dependency and a cluster to run for every self-hosted install, so the architecture plan postponed it while asking for a workflow interface from the start. We decided on a small engine of our own behind that interface: `defineWorkflow` declares a straight line of named steps (run, sleep, wait for a signal), `ctx.workflows` starts, signals, cancels and reads runs, each run's state lives in `workflow_run` and its signals in `workflow_signal`, every step runs as an ordinary `workflow.step` job through `JobQueue`, and `sync.tick` (ADR 0008) enqueues a `workflow.sweep` that re-enqueues every run that is due. A step's result is committed in the same row update that enters the next step, so a crash after the commit loses only the next job, which the sweep recreates. This keeps all durable state in Postgres, needs no new dependency or infrastructure, and the declarative step list is exactly what a generated Temporal workflow function would iterate.

## Contract

- **Steps are at-least-once.** A step is claimed atomically with a 10-minute lease. The claim is counted on the run (`attempts`) but does not change `version`; only moving on (next step, failure, cancel) does. So:
  - a step still running when its lease expires is started again *beside* the first execution, and every 10 minutes after that while none finishes. There is no heartbeat yet (#69), so keep steps well under 10 minutes;
  - the first execution to finish commits its result; later ones are discarded, as is the result of a step that was running when the run was cancelled;
  - after 5 executions (claims) without one finishing (each worker died or hung), the next job fails the run. Exactly-once *effects* are the step's own job: deterministic ids, unique keys, read-then-write guards.
- **Retries:** a step that throws releases its lease and the queue retries it with its backoff. Attempts are counted on the run, not taken from the queue, so a job lost with Redis does not reset them. The fifth attempt or a `PermanentJobError` fails the run. `RetryLaterError` delays the step without using an attempt. A wait whose timeout passes fails the run.
- **Timers** fire through a delayed hint job, or at the latest on the first tick after their time.
- **Signals** are kept until a wait step for them consumes them, one signal per wait step: a signal sent twice (a repeated webhook) is also consumed by a later wait step with the same name.
- **The sweep** takes due runs least recently swept first (500 per tick), so runs whose job finds nothing to do (a workflow this worker does not know, pushed back by a lease each time) cannot starve the others. A waiting run is due only for an unconsumed signal of the name it waits for (`waitingFor`). The sweep reads across organizations (run ids and organization ids only), the second such read in the core after `sync.tick`.
- **Values:** the input and signal payloads are stored as the caller passed them and parsed with their schema whenever they are used. `start` and `signal` refuse anything whose JSON form does not parse back to the same value (`z.date()`, for example) or is larger than 256 KB, so the caller gets the error instead of a run that fails later. A step result must be JSON of at most 256 KB, or the run fails. The run's `lastError` holds the error's name, code and one truncated line, like a Sync state's, never the full message.
- **Keys:** `key` is unique per organization and workflow, ever: `start` with a key already used returns that run, even if it has finished, and ignores the new input. A Temporal engine would have to use the "reject duplicate" workflow id reuse policy to behave the same.
- **Changed definitions:** the run records the steps it has done (`completedSteps`). If the definition no longer starts with them, or its next step is not the run's current step, the run fails with a clear error instead of re-running or skipping a step. Steps appended after the current one are picked up. Proper versioning is #43.
- **Tenancy:** every engine method is scoped to `organizationId`, and the database refuses a signal whose organization differs from its run's (composite foreign key).

## Mapping to Temporal

| Here | Temporal |
| --- | --- |
| workflow definition (step list) | workflow type: a generated function iterating the steps |
| `step` | activity, same retry policy (5 attempts); the lease is its start-to-close timeout |
| `sleep` | `sleep()` durable timer |
| `waitForSignal` | `defineSignal` + `condition()` with timeout |
| `key` | workflow id (scoped by organization), reuse policy "reject duplicate" |
| `start` / `signal` / `cancel` | `client.workflow.start` / `handle.signal` / `handle.cancel` |
| `get` / `list` | `handle.describe` / visibility list with `organizationId` as a search attribute |
| lease, `version`, `completedSteps`, sweep, `workflow.*` jobs | not needed: the Temporal server does this |

Not supported, each a follow-up:
- changing a definition while runs are in flight (#43);
- branching, child workflows, compensation and cooperative cancellation (#44);
- queries, updates, continue-as-new and scheduled starts (#45);
- a panel view (#46);
- pruning finished runs (#47);
- heartbeats for long steps (#69).

Whether to swap in Temporal is #42.

## Considered options

- Temporal, Restate or a Postgres job library: a new production dependency and, for Temporal, a cluster per install.
- Workflows as code replayed deterministically: needs a replay engine and a much larger surface.
- BullMQ flows: the state would live in Redis, which is exactly what must be survivable.
- A schedule per run: rejected for the same reason as a schedule per Connection (ADR 0008).

## Consequences

- A timer or signal whose job was lost runs up to one tick late.
- A step longer than the 10-minute lease is started again beside itself every 10 minutes; the first execution to finish wins, and if none of five finishes the run fails. Long work belongs in its own job, with the workflow waiting for a signal.
