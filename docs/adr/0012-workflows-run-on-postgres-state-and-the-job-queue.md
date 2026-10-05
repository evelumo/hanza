# Durable workflows run on Postgres state and the job queue, shaped so Temporal can replace them

Status: accepted (issue #8)

The automations stage needs processes that span days and several systems (order → label → invoice), and they must survive a worker crash or a lost Redis between steps. Temporal does this, but it is a new production dependency and a cluster to run for every self-hosted install, so the architecture plan postponed it while asking for a workflow interface from the start. We decided on a small engine of our own behind that interface: `defineWorkflow` declares a straight line of named steps (run, sleep, wait for a signal), `ctx.workflows` starts, signals, cancels and reads runs, each run's state lives in `workflow_run` (current step, results, status, wake-up time, attempts, error, version) and its signals in `workflow_signal`, every step runs as an ordinary `workflow.step` job through `JobQueue`, and `sync.tick` (ADR 0008) enqueues a `workflow.sweep` that re-enqueues every run that is due. A step's result is committed in the same row update that enters the next step, so a crash after the commit loses only the next job, which the sweep recreates; a crash before it re-runs the step. This keeps all durable state in Postgres, needs no new dependency or infrastructure, and the declarative step list is exactly what a generated Temporal workflow function would iterate.

## Contract

- Steps are **at-least-once**: a step runs again after a crash, an expired lease (10 minutes) or a lost claim, and a cancelled run's in-flight result is discarded. Exactly-once *effects* are the step's own job (deterministic ids, unique keys, read-then-write guards). Results are committed exactly once, guarded by the run's `version`.
- Retries are the queue's (5 attempts, exponential backoff); the last attempt or a `PermanentJobError` fails the run. A wait whose timeout passes fails the run.
- Timers fire through a delayed hint job, or at the latest on the first tick after their time. A signal sent before the run reaches its wait step is kept.
- Every engine method is scoped to `organizationId`; `key` is unique per organization and workflow (start is idempotent per key). The sweep reads across organizations (run ids and organization ids only), the second such read in the core after `sync.tick`.

## Mapping to Temporal

| Here | Temporal |
| --- | --- |
| workflow definition (step list) | workflow type: a generated function iterating the steps |
| `step` | activity, same retry policy |
| `sleep` | `sleep()` durable timer |
| `waitForSignal` | `defineSignal` + `condition()` with timeout |
| `key` | workflow id (scoped by organization) |
| `start` / `signal` / `cancel` | `client.workflow.start` / `handle.signal` / `handle.cancel` |
| `get` / `list` | `handle.describe` / visibility list with `organizationId` as a search attribute |
| lease, `version`, sweep, `workflow.*` jobs | not needed: the Temporal server does this |

Not supported, each a follow-up: changing a definition while runs are in flight (#43; a run whose current step changed fails), branching, child workflows, compensation and cooperative cancellation (#44), queries, updates, continue-as-new and scheduled starts (#45), a panel view (#46), pruning finished runs (#47). Whether to swap in Temporal is #42.

## Considered options

- Temporal, Restate or a Postgres job library: a new production dependency and, for Temporal, a cluster per install.
- Workflows as code replayed deterministically: needs a replay engine and a much larger surface.
- BullMQ flows: the state would live in Redis, which is exactly what must be survivable.
- A schedule per run: rejected for the same reason as a schedule per Connection (ADR 0008).

## Consequences

- One tick of extra latency for a timer or signal whose job was lost; a waiting run holding a signal meant for a later wait step gets a no-op job each tick.
- Long steps (over the lease) can run twice concurrently; keep steps short and idempotent.
