# Testing

Hanza tests different layers separately. A green unit run does not prove the panel works in a browser or a live Channel accepts a connector.

## Test layers

| Layer | Command | Prerequisites and scope |
| --- | --- | --- |
| Dependency boundaries | `pnpm check:boundaries` | Static connector/package checks |
| Type checks | `pnpm typecheck` | Dependencies and generated Prisma client |
| Unit and helper tests | `pnpm test` | Vitest; no real external accounts or API traffic |
| Database integration | `pnpm test` | `HANZA_TEST_DATABASE_URL` pointing at a server where tests may create/drop databases |
| Redis rate limiter | `pnpm test` | A reachable Redis at `REDIS_URL`; uses an isolated prefix |
| Connector conformance | `pnpm --filter @hanza/connector-fake test` | In-memory references and scrubbed recorded HTTP fixtures |
| Web build | `pnpm build` | Valid build-time env; compiles Next.js |
| Panel browser flows | `pnpm test:e2e` | Local Postgres, Redis and installed Playwright Chromium |

Database tests (`*.db.test.ts`) create a throwaway database, apply migrations and drop it afterwards. They are skipped when `HANZA_TEST_DATABASE_URL` is unset. Redis tests skip when no Redis answers. Read the output; a command exiting successfully can include skipped layers.

CI currently provides Postgres, generates Prisma, checks boundaries/types, runs Vitest and builds the web app. It provides no Redis service and does not run Playwright flows. See [the checked-in CI workflow](../.github/workflows/ci.yml).

## Local validation

After following [the quick start](quick-start.md), keep `HANZA_TEST_DATABASE_URL` set to the local Postgres URL in `.env` and local infra running:

```sh
pnpm db:generate
pnpm check:boundaries
pnpm typecheck
pnpm test
pnpm build
```

Use the smallest relevant subset in that order: boundary checks for connector changes; generation for a fresh checkout/schema changes; build for web/shared-config changes. See [CONTRIBUTING.md](../CONTRIBUTING.md#validate).

## Browser flows

Install Chromium once:

```sh
pnpm --filter @hanza/e2e exec playwright install chromium
```

Run the suite or pass arguments to Playwright:

```sh
pnpm test:e2e
pnpm test:e2e --grep stock
pnpm test:e2e --headed
```

The runner builds the web app, starts a web server and worker on free ports, and creates a database and Redis queue prefix named after a random run id. It does not use the development database or queue. Redis must be loopback unless the explicit remote-Redis opt-in is set; use local infrastructure for routine runs.

**The runner skips with exit 0** if the test database URL or browser is missing. A `skipped` message means browser verification did not happen.

On normal completion or a handled interruption, the runner stops its processes, drops its database and deletes only its Redis keys/record. Failed or interrupted results stay under `apps/e2e/results/<run id>/`; a green run removes its results directory. After a hard crash, the next run recovers provably dead runs. See [AGENTS.md](../AGENTS.md#panel-end-to-end-flows) for the recovery contract.

Inspect retained evidence:

```sh
pnpm --filter @hanza/e2e exec playwright show-trace path/to/trace.zip
```

The directory also contains `logs/`, `test-results/` and `report/`. Review evidence for secrets or Buyer data before sharing it.

## Add a test

Keep Vitest logic deterministic and network-free. Connector HTTP tests replay scrubbed cassettes; recording is a separate deliberate sandbox operation described in [the connector guide](../packages/connectors/README.md#recorded-fixtures).

Panel flows import fixtures from `apps/e2e/src/fixtures.ts`, create a fresh organization for each test, use roles/accessible names, and wait for observable results rather than fixed sleeps. Follow [the E2E workspace guide](../apps/e2e/README.md). After a panel/flow change, run the browser suite three times before a PR.

In PRs report the layers run, skipped checks and observed failures. Live marketplace compatibility, physical shipments and production deployment need separate acceptance evidence.
