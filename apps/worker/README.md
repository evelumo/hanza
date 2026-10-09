# @hanza/worker

The separate process that runs Hanza's registered jobs and workflow steps. Long-running sync and connector sign-in happen here, outside Next.js.

## Run

Use `pnpm dev` at the root for web and worker watch mode, or start the worker separately:

```sh
pnpm --filter @hanza/worker start
```

The worker runs TypeScript source with `tsx`; it has no build step. It reads the root `.env`. Postgres and Redis must be available, and web/worker must use the same database, encryption key, Redis and queue namespace.

## Responsibilities

The entry point composes `createContext()` with connectors from `@hanza/connector-registry`, starts the queue worker, and schedules `sync.tick` and `privacy.tick`. Jobs are defined/registered in the core. `WORKER_CONCURRENCY` defaults to 10.

Job effects must be idempotent: retries repeat execution. Multi-step durable work uses `ctx.workflows`; its steps have an at-least-once execution contract. Read [architecture](../../docs/architecture.md) before adding background behaviour.

Database-backed tests in `src/*.db.test.ts` exercise engine, workflow, privacy and sync paths with fake/reference connectors. They use throwaway databases when `HANZA_TEST_DATABASE_URL` is set. The E2E runner also preloads a fake-Channel probe in this process for browser assertions; that probe is test infrastructure, not an application endpoint.

See [testing](../../docs/testing.md) and [self-hosting](../../docs/self-hosting.md). A healthy web `/api/health` response does not prove this process is consuming jobs.
