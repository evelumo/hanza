<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# Hanza — guide for contributors and AI agents

Hanza is an open-source (MIT), self-hosted, AI-native e-commerce integration hub (an alternative to base.com / BaseLinker). A small, stable core (canonical data model + sync engine) talks to marketplaces, shops, couriers and invoicing tools through replaceable **connectors**. Stack: Next.js (panel + API), Prisma + PostgreSQL, BullMQ + Redis, a separate worker process, Better Auth, zod, pnpm + Turborepo, Vitest. Early scaffold: auth, tenants and the queue pipeline work; there are no real connectors yet, only a fake one for tests and demos. The vision and roadmap live in `docs/plan-architektury.html` (Polish).

Items marked **planned** do not exist yet. Do not assume them.

## Repo map

| Path | What it is |
| --- | --- |
| `apps/web` | `@hanza/web` — Next.js App Router: panel (Products, Product families, Orders, Warehouses, Connections, Privacy, Settings with the organization's Order statuses, dashboard), Better Auth routes, `GET /api/health`. The panel speaks English (default) and Polish: the locale comes from the `hanza_locale` cookie, then `Accept-Language`, set with the switcher; copy lives in `apps/web/messages/{en,pl}.json` (`next-intl`, no locale in the URL). |
| `apps/worker` | `@hanza/worker` — the worker process (run with `tsx`, no build step): `startWorker` with the jobs from the core registry and the connectors from `@hanza/connector-registry`; schedules `sync.tick` and `privacy.tick`. Holds the end-to-end engine test (`src/engine.db.test.ts`), the workflow one (`src/workflows.db.test.ts`) and the Buyer data privacy one (`src/privacy.db.test.ts`). |
| `apps/e2e` | `@hanza/e2e` — panel end-to-end tests: Playwright flows in `flows/*.spec.ts`, helpers in `src/fixtures.ts`, and the runner behind `pnpm test:e2e` (`src/run.ts`). See [Panel end-to-end flows](#panel-end-to-end-flows). |
| `packages/core` | `@hanza/core` — `createContext()`, env validation, logger, `JobQueue` + BullMQ implementation (`startWorker`), `defineJob`, job and workflow registry, domain services, sync engine (`src/sync`, `src/jobs`), durable workflows (`src/workflows`: `defineWorkflow`, `ctx.workflows`), the rate limiter connectors' requests go through (`src/rate-limit`, `ctx.rateLimiter`, ADR 0019). Test helpers at `@hanza/core/testing`. |
| `packages/db` | `@hanza/db` — Prisma schema (split per module), migrations, client factory `createDb()`. |
| `packages/connector-sdk` | `@hanza/connector-sdk` — `defineConnector`, capability types, canonical `Order` / `Offer` / `StockLevel` zod schemas, error taxonomy (`ConnectorError`), conformance kit at `@hanza/connector-sdk/testing`. |
| `packages/connectors/<id>` | One package per connector, `@hanza/connector-<id>`. Only `fake` (`@hanza/connector-fake`: the in-memory Channel `fake` for tests; `fake-oauth`, the same behind an OAuth sign-in; and the unregistered `fake-http` that reaches the same Channel over HTTP and is tested on recorded fixtures) so far. Connector tests replay recorded, scrubbed HTTP cassettes (`runConformance` in `@hanza/connector-sdk/testing`; recording: `packages/connectors/README.md`, "Recorded fixtures"). |
| `packages/connector-registry` | `@hanza/connector-registry` — the list of connectors this build knows; the only package that depends on connectors. The apps pass it to `createContext({ connectors })`. |
| `scripts/check-boundaries.mjs` | Enforces the dependency boundaries below. |
| `.ai/skills` | Agent skills. |
| `docs/adr`, `CONTEXT-MAP.md`, `*/CONTEXT.md` | Decisions (ADRs), and the glossaries of the domain vocabulary. Specs are GitHub issues, not files. |
| `docs/plan-architektury.html` | Architecture plan and roadmap (Polish). |

## Commands

Run from the repo root. Local infra uses non-default host ports: Postgres 5442, Redis 6389.

| Command | What it does |
| --- | --- |
| `pnpm infra:up` / `pnpm infra:down` | Start / stop Postgres + Redis via Docker Compose. |
| `pnpm dev` | `turbo run dev`: Next.js dev server (http://localhost:3000) and the worker (watch mode). |
| `pnpm db:generate` | Generate the Prisma client into `packages/db/src/generated` (needs no database). |
| `pnpm db:migrate` | `prisma migrate dev`: create and apply a migration after a schema change (needs the database). |
| `pnpm db:deploy` | `prisma migrate deploy`: apply existing migrations. |
| `pnpm check:boundaries` | Fail if a connector depends on anything but `@hanza/connector-sdk` and `zod`, if `core`, `db` or the SDK depend on a connector or the registry, or if anything but the registry lists a connector in `dependencies` (apps may in `devDependencies`). |
| `pnpm typecheck` | `turbo run typecheck` (the web package runs `next typegen` first). |
| `pnpm test` | `turbo run test` (Vitest in `core`, `connector-sdk`, `connectors/fake`, `apps/worker`, `apps/web` and `apps/e2e`; the web tests cover pure helpers only, the e2e ones the runner's helpers; no browser starts). Database-backed tests (`*.db.test.ts`) run when `HANZA_TEST_DATABASE_URL` is set: each run creates a throwaway database on that server, applies every migration and drops it afterwards; with the variable unset they are skipped. Redis-backed tests (the rate limiter's) use `REDIS_URL` under a prefix of their own and are skipped when no Redis answers there. |
| `pnpm build` | `turbo run build` (only `apps/web` has a build; the worker runs from source). |
| `pnpm test:e2e` | Panel end-to-end flows in Chromium (Playwright), **local only, not in CI yet**. See [Panel end-to-end flows](#panel-end-to-end-flows) for what a run creates and how it is cleaned up. Skipped (exit 0, with a message) when `HANZA_TEST_DATABASE_URL` is unset or the browser is missing: install it once with `pnpm --filter @hanza/e2e exec playwright install chromium`. Arguments go to Playwright: `pnpm test:e2e --grep stock`, `pnpm test:e2e --headed`. Results of a failed or interrupted run stay in `apps/e2e/results/<run id>/` (`logs/` of web and worker, `test-results/` with traces: `pnpm --filter @hanza/e2e exec playwright show-trace <zip>`, `report/`); a green run deletes its directory. About 20 s with a cached build. |

Config: copy `.env.example` to `.env` at the repo root (read by web, worker and Prisma); set `BETTER_AUTH_SECRET` and `HANZA_ENCRYPTION_KEY` (each `openssl rand -base64 32`; the key seals Connection credentials, and losing it means signing in to every connector again). Keep `HANZA_TEST_DATABASE_URL` pointing at the local Postgres (`pnpm infra:up`) so `pnpm test` runs the database tests. Not available yet (**planned**): `pnpm generate` (connector auto-discovery), `pnpm create-connector`, `pnpm test:connector <id>`, natural-language panel tests with the tester-army `e2e` package on top of Playwright (github.com/tester-army/e2e), `pnpm test:e2e` in CI.

## Task router

| If you are... | Read / edit |
| --- | --- |
| Adding a DB table | New `packages/db/prisma/schema/<module>.prisma` (or extend the module's file); tenant-owned tables get `organizationId` + relation to `Organization` + an index starting with it (see `EventLog` in `core.prisma`). Then `pnpm db:migrate`, commit the migration. Add the back-relation to `Organization` in `auth.prisma`. |
| Adding a background job | `packages/core/src/jobs/<name>.ts` using `defineJob` (see `system-ping.ts`): dotted name, zod payload including `organizationId`. Register it in `packages/core/src/registry.ts`, export from `index.ts`. Enqueue with `ctx.queue.enqueue(job, payload)`. Add a Vitest test for non-trivial logic. |
| Adding a panel page / API route / server action | `apps/web/src/app/...`. Page groups: `(auth)` public, `(panel)` behind login. Call `requireTenant()` (`apps/web/src/lib/session.ts`) first and scope every query by the returned `organizationId`. Get dependencies from `getContext()` (`lib/context.ts`). Validate input with zod. See `(panel)/dashboard/` for page + server action + queue, `(panel)/products/` for list/detail pages with `useActionState` forms (`components/action-form.tsx`), and `lib/domain-errors.ts` for the messages of `DomainError` codes. Server actions return `{ error }` instead of throwing for expected failures, in the request's locale. A new screen or flow gets a Playwright flow in `apps/e2e/flows/` (see [Panel end-to-end flows](#panel-end-to-end-flows)). **Adding a string:** add the key to `apps/web/messages/en.json` (source of truth, keys are type-checked) and the same key to `pl.json`, then use the translator: `await getT()` in server components and actions (`@/i18n/server`), `useT()` in client components and sync ones (`@/i18n/use-t`); use ICU plurals for counts and `lib/formatters.ts` / `lib/format.ts` for dates, numbers and money. Zod schemas carry message keys (`messageKey('validation.…')`), never text. Never hard-code UI text. |
| Adding a workflow | `packages/core/src/workflows/<name>.ts` using `defineWorkflow` (see `system-check.ts` and ADR 0014): dotted name, zod input, named steps (`.step`, `.sleep`, `.waitForSignal`). Steps are at-least-once (a step still running after its 10-minute lease is started again), so make each step's effect idempotent and keep steps short; inputs, results and signal payloads are JSON (no `z.date()`), at most 256 KB, and hold ids only. Register it in `workflows` in `packages/core/src/registry.ts`, export it. Start with `ctx.workflows.start(workflow, organizationId, input, { key })`, resume with `ctx.workflows.signal(...)`. Test it through `buildJobs([...workflows, yours])` (see `apps/worker/src/workflows.db.test.ts`). |
| Adding a connector | `.ai/skills/add-connector/SKILL.md`, `packages/connectors/README.md`, `packages/connector-sdk/src`. Make it available to the apps with a dependency and one line in `packages/connector-registry/src/index.ts`. Need an SDK or core change to finish? Stop and write a spec (a GitHub issue). |
| Changing auth | `apps/web/src/lib/auth.ts` (Better Auth config), `auth-client.ts`, `session.ts`, `packages/db/prisma/schema/auth.prisma`. Ask first. After changing Better Auth plugins, regenerate the reference schema with the Better Auth CLI and write a migration. |
| Changing the canonical model | `packages/connector-sdk/src/model/*`. Spec (a GitHub issue) first, ask first. Then update every mapper/connector and the DB schema that stores it. |
| Changing the Connector SDK contract | `packages/connector-sdk/src/connector.ts`. Spec (a GitHub issue) first, ask first. |
| Adding an env variable | Add to the zod schema in `packages/core/src/env.ts`, `.env.example`, the dummy env in `.github/workflows/ci.yml`, and `globalEnv` (or the task's `env`) in `turbo.json` — Turborepo's strict env mode hides undeclared variables from tasks. Exception: the optional `HANZA_QUEUE_PREFIX` (BullMQ key prefix) is set only by the e2e runner, which starts the apps without turbo; under turbo the apps use BullMQ's default prefix. A connector's installation settings are not core env: they follow `HANZA_CONNECTOR_<ID>_<FIELD>` from the connector's `appConfigSchema`, `turbo.json` passes `HANZA_CONNECTOR_*` through to the `dev` task only (`passThroughEnv`, so secrets never enter a cache key), CI sets none, and they go (commented) in `.env.example`. |
| Changing the queue | `packages/core/src/queue.ts`. Keep the `JobQueue` interface engine-neutral. |
| Touching Order status logic | ADR 0003 and ADR 0018. The core and connectors reason about the fixed **Order phase** (`order.phase`, `packages/core/src/orders/status-rules.ts`); an organization's **Order statuses** (`packages/core/src/order-statuses/`) are labels within a phase and never change Stock or what a Channel is told. Give an Order a status only through `changeOrderStatus` / `importOrder` (they keep phase and status consistent; the composite foreign key refuses anything else). |

## Architecture rules

- **Dependency direction:** `apps/*` → `@hanza/core` → `@hanza/db` (and `@hanza/core` → `@hanza/connector-sdk`); `apps/*` → `@hanza/connector-registry` → connectors → `@hanza/connector-sdk` only. The core never depends on a connector or the registry: the apps pass connector definitions into `createContext()`. Packages never import from `apps/*`. `@hanza/db` imports nothing from the workspace. `pnpm check:boundaries` enforces this.
- **Connectors** live in `packages/connectors/<id>/`, depend only on `@hanza/connector-sdk` and `zod` (`pnpm check:boundaries`), contain no UI, never touch the database, never import the core or another connector. They speak Order phases, never an organization's Order statuses (ADR 0018). The core hands them a `CapabilityContext` (its own installation settings, validated config, decrypted credentials, plain `fetch` with a 30 s timeout that also enforces the connector's declared `rateLimits` (ADR 0019), logger); a connector adds its own authentication to its requests, never logs credentials, and throws `ConnectorError` subclasses so the core knows whether to retry. For OAuth the core owns token lifetime: when to refresh, one refresh per Connection at a time, storing the rotated credentials (ADR 0020); token refreshes and device-flow sign-ins go through the same limited `fetch`; sign-in runs in the worker (`connections.signIn.*` jobs), never in Next.js.
- **Buyer data is sealed:** an Order's Buyer data is written only through `sealBuyerData` and read through `readBuyerData` (`packages/core/src/privacy`). Never add a plaintext column, query argument, Event payload or log field that holds it (ADR 0016).
- **Tenant scoping:** an organization is the tenant. Every tenant-owned table has `organizationId`; every panel page/route/action takes it from `requireTenant()`; every job payload carries it. Never trust an `organizationId` from client input.
- **Queue behind an interface:** callers use `JobQueue` from the context, never `bullmq` directly (only `packages/core/src/queue.ts` touches it; the worker calls `startWorker`). The only other code that talks to Redis is the rate limiter (`packages/core/src/rate-limit/redis.ts`), behind its own `RateLimiter` interface. Temporal is deliberately postponed; the interface exists so it can be swapped in later. Multi-step work goes through `ctx.workflows` (`WorkflowEngine`), not hand-chained jobs: its stage-1 engine keeps run state in Postgres and runs steps as jobs (ADR 0014), and a Temporal engine can replace it behind the same interface.
- **Background work runs in the worker**, never in the Next.js process. Jobs must be idempotent (the queue retries: 5 attempts, exponential backoff).
- **Explicit context, no DI container:** dependencies are composed in `createContext()` (`packages/core/src/context.ts`) and passed down. Add a service by adding a field there.
- **Validate at boundaries with zod** (env, job payloads, connector config, external API responses, request input). Infer types from schemas instead of duplicating them.
- **Money is a decimal string** plus ISO currency (`{ amount: "129.99", currency: "PLN" }`), never a float.
- **Prisma schema is split per module** in `packages/db/prisma/schema/*.prisma`; `base.prisma` holds the generator and datasource only.
- **Better Auth owns** `user`, `session`, `account`, `verification`, `organization`, `member`, `invitation`. Do not repurpose them for domain data.

## Specs, decisions and vocabulary

Each kind of design record has one home.

- **Specs are GitHub issues.** A non-trivial change (new module, DB model, SDK/canonical-model change, new capability or public API, anything touching auth, tenancy, stock or sync semantics, the job/queue contract or the shape of `createContext()`, a new production dependency) starts with a spec written as an issue in this repo, created with `gh` as described in `docs/agents/issue-tracker.md`. Give it: summary, problem and non-goals, proposed design (packages and files involved, failure modes, idempotency, alternatives dropped), data model and SDK/API changes (or "None"), tenant and security considerations, test plan, rollout, open questions. Get it reviewed on the issue before implementing, keep it current while you work, and reference it from the PRs. When it ships, comment with the PRs and close it; from then on the code and the ADRs are the source of truth. Bug fixes, refactors with no contract change, copy changes and adding a connector that fits the current SDK need no spec. If a task needs such a change and no spec exists, write the spec and stop for review; do not start on the code.
- **Decisions go in `docs/adr/`.** Write an ADR (`docs/adr/NNNN-slug.md`: a title, then one to three sentences each on context, decision and why; optional Status, Considered options, Consequences) only for a decision that is hard to reverse, surprising without context, and a real trade-off. Read the ADRs that touch the area you change before editing it, and say so if your change contradicts one.
- **Vocabulary goes in `CONTEXT.md`.** Domain terms are defined in the glossaries listed in `CONTEXT-MAP.md`; use them, and avoid the words they list under _Avoid_. See `docs/agents/domain.md`.

## Always / Ask first / Never

**Always**
- Scope tenant data by `organizationId`; start panel code with `requireTenant()`.
- Add a Prisma migration with every schema change (`pnpm db:migrate`) and commit it.
- Run the validation gate below before declaring work done; report anything you could not run.
- Write or update tests for logic you add (Vitest, deterministic, no real network or accounts).
- Mark anything unfinished as a `TODO`/**planned**, and keep docs true to the code.
- Read the ADRs and glossaries for the area before changing it; record a decision that meets the ADR bar in `docs/adr/`.

**Ask first**
- Adding a production dependency.
- Starting a non-trivial change before its spec issue has been reviewed.
- Changing the canonical model or the Connector SDK contract.
- Changing Better Auth configuration or the auth tables.
- Touching stock-reservation or inventory-sync logic (races sell goods that do not exist; this is not agent-only code).
- Changing `turbo.json`, CI, or the Docker Compose setup.

**Never**
- Expose or query data across tenants.
- Import `@hanza/db` (or `@hanza/core`) from a connector, or add any other dependency to a connector.
- Edit `packages/db/src/generated` (git-ignored; produced by `pnpm db:generate`).
- Hand-edit an applied migration; add a new one.
- Run sync or other long work inside the Next.js process.
- Hard-code user-facing strings in components or actions; add them to the message catalogues.
- Commit `.env` or secrets; log tokens or personal data.
- Use floats for money.

## Validation gate

Run the smallest relevant subset, in this order:

1. `pnpm db:generate` — after any `*.prisma` change, or on a fresh checkout.
2. `pnpm check:boundaries` — after touching `packages/connectors/**`.
3. `pnpm typecheck`
4. `pnpm test`
5. `pnpm build` — after touching `apps/web` or shared config.

CI (`.github/workflows/ci.yml`) runs all of them with dummy env values; no database or Redis is needed.

After changing a panel screen or a flow, also run `pnpm test:e2e` (local only; CI does not run it yet).

## Panel end-to-end flows

`pnpm test:e2e` runs `apps/e2e/flows/*.spec.ts` against a real web app and worker. What a run creates, all named after its random run id: a database `hanza_e2e_<id>` on the `HANZA_TEST_DATABASE_URL` server (every migration applied), queue keys `hanza-e2e-<id>:*` in `REDIS_URL`'s database (the apps get `HANZA_QUEUE_PREFIX`, so a run never shares jobs with a dev worker or another run, and parallel runs are fine), an entry in the Redis hash `hanza-e2e:runs` recording all of that, free ports, and `apps/e2e/results/<id>/`. It refuses a non-loopback `REDIS_URL` unless `HANZA_E2E_ALLOW_REMOTE_REDIS=1`, and it never flushes a Redis database: it deletes only its own keys.

Cleanup: on a normal end, failing flows, or SIGINT (Ctrl-C), SIGTERM or SIGHUP to the runner or its process group, also during setup or the build, the runner stops its processes (worker, `next start`, build, Playwright, each in its own process group), drops its database and deletes its keys and record. If the runner is killed with SIGKILL (or crashes), its processes die with it: each is started with `apps/e2e/src/parent-guard.mjs` preloaded, which kills its process group when the runner's end of its stdin closes. Its database, keys and record stay; the next `pnpm test:e2e` on the same machine finds the record of a runner that provably no longer runs (`ps` reports no such PID, or the PID has another start time; if `ps` cannot tell, the record is left for a later run), kills every process still carrying that run's id on its command line and every recorded child whose PID still has its recorded start time (`next start` renames itself to `next-server` and loses the id), each with its process group, then drops the database and deletes the keys. To clean up without running the flows, start a run and interrupt it.

To add a flow for your feature:

1. Add `apps/e2e/flows/<feature>.spec.ts` and import `test` and `expect` from `../src/fixtures` (not from `@playwright/test`), plus the helpers you need: `signUp(page)` creates a fresh user and organization through the Better Auth API in the page's session and ends on the dashboard (only `auth.spec.ts` goes through the forms, with `signUpThroughForms`: Better Auth allows 3 sign-ups/sign-ins per 10 s per client address, and `signUp` sends each account from its own address in `X-Forwarded-For`); `addFakeConnection(page, name?)` adds a fake Connection (its first sync imports the fake Channel's seed, see `packages/connectors/fake/src/seed.ts`) and returns its id; `waitForSeedOrders(page)` waits until the four seed Orders are imported; `reloadUntil(page, path, check)` reloads a page until the result of a background job shows.
2. Start every test with its own `signUp`, so a flow runs alone (`pnpm test:e2e --grep <name>`) and in any order. Use a SKU no seed Offer has unless you mean to push stock to the fake Channel.
3. Locate by role and accessible name in English (the flows run in `en-GB`): `getByRole('button', { name: 'Save stock' })`, `getByLabel('SKU', { exact: true })`, `getByRole('region', { name: 'Stock', exact: true })` (every `Section` is a region named by its title), `getByRole('row').filter({ has: … })`. If an element has no accessible name, give it one in the panel (a label, `aria-labelledby`, a named group); no `data-testid` and no CSS selectors (the one exception: a hidden input a flow rewrites on purpose to send a forged id, as `tenant-isolation.spec.ts` does). Wait for the new page's heading before using a label that also exists on the previous page.
4. What the worker sends to the fake Channel lives in the worker's memory: read it with the `fakeChannel` fixture (`(await fakeChannel.calls()).stockPushes` / `.statusUpdates`, served by `src/fake-channel-probe.ts`, which the runner preloads into the worker). It is shared by every flow of the run, so take its length before acting and look only at what came after. For state the panel does not show, the `db` fixture is a `pg` pool on the run's database (plain SQL, scope every query by organization).
5. Background results are asynchronous: use `expect.poll`, `reloadUntil` or Playwright's auto-waiting assertions, never fixed sleeps. One worker and no retries are configured on purpose: a flaky flow must fail. Run `pnpm test:e2e` three times before you open the PR.

## Code style

TypeScript strict, ESM. No semicolons, single quotes, trailing commas in multi-line literals, 2-space indent, `import type` for types (`verbatimModuleSyntax`). Small focused files; one concept per file. Comments only explain *why* (a constraint, a gotcha), not what. Names: files `kebab-case.ts`, job names `domain.action`, connector ids lowercase slugs. Code, identifiers and docs are in English; the panel's copy is translated through the message catalogues (English default, Polish second).

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context: a root `CONTEXT-MAP.md` points to per-package `CONTEXT.md` files; system-wide ADRs in `docs/adr/`. See `docs/agents/domain.md`.
