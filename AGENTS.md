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
| `apps/web` | `@hanza/web` — Next.js App Router: panel (Products, Orders, Connections, dashboard), Better Auth routes, `GET /api/health`. The panel speaks English (default) and Polish: the locale comes from the `hanza_locale` cookie, then `Accept-Language`, set with the switcher; copy lives in `apps/web/messages/{en,pl}.json` (`next-intl`, no locale in the URL). |
| `apps/worker` | `@hanza/worker` — the worker process (run with `tsx`, no build step): `startWorker` with the jobs from the core registry and the connectors from `@hanza/connector-registry`; schedules `sync.tick` and `privacy.tick`. Holds the end-to-end tests (`src/engine.db.test.ts`, `src/privacy.db.test.ts`). |
| `packages/core` | `@hanza/core` — `createContext()`, env validation, logger, `JobQueue` + BullMQ implementation (`startWorker`), `defineJob`, job registry, domain services, sync engine (`src/sync`, `src/jobs`). Test helpers at `@hanza/core/testing`. |
| `packages/db` | `@hanza/db` — Prisma schema (split per module), migrations, client factory `createDb()`. |
| `packages/connector-sdk` | `@hanza/connector-sdk` — `defineConnector`, capability types, canonical `Order` / `Offer` / `StockLevel` zod schemas, error taxonomy (`ConnectorError`), conformance kit at `@hanza/connector-sdk/testing`. |
| `packages/connectors/<id>` | One package per connector, `@hanza/connector-<id>`. Only `fake` (`@hanza/connector-fake`, an in-memory Channel for tests) so far. |
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
| `pnpm test` | `turbo run test` (Vitest in `core`, `connector-sdk`, `connectors/fake`, `apps/worker` and `apps/web`; the web tests cover pure helpers only). Database-backed tests (`*.db.test.ts`) run when `HANZA_TEST_DATABASE_URL` is set: each run creates a throwaway database on that server, applies every migration and drops it afterwards; with the variable unset they are skipped. |
| `pnpm build` | `turbo run build` (only `apps/web` has a build; the worker runs from source). |

Config: copy `.env.example` to `.env` at the repo root (read by web, worker and Prisma); set `BETTER_AUTH_SECRET` and `HANZA_ENCRYPTION_KEY` (each `openssl rand -base64 32`; the key seals Connection credentials, and losing it means signing in to every connector again). Keep `HANZA_TEST_DATABASE_URL` pointing at the local Postgres (`pnpm infra:up`) so `pnpm test` runs the database tests. Not available yet (**planned**): `pnpm generate` (connector auto-discovery), `pnpm create-connector`, `pnpm test:connector <id>`, panel E2E tests (the `e2e` package, github.com/tester-army/e2e).

## Task router

| If you are... | Read / edit |
| --- | --- |
| Adding a DB table | New `packages/db/prisma/schema/<module>.prisma` (or extend the module's file); tenant-owned tables get `organizationId` + relation to `Organization` + an index starting with it (see `EventLog` in `core.prisma`). Then `pnpm db:migrate`, commit the migration. Add the back-relation to `Organization` in `auth.prisma`. |
| Adding a background job | `packages/core/src/jobs/<name>.ts` using `defineJob` (see `system-ping.ts`): dotted name, zod payload including `organizationId`. Register it in `packages/core/src/registry.ts`, export from `index.ts`. Enqueue with `ctx.queue.enqueue(job, payload)`. Add a Vitest test for non-trivial logic. |
| Adding a panel page / API route / server action | `apps/web/src/app/...`. Page groups: `(auth)` public, `(panel)` behind login. Call `requireTenant()` (`apps/web/src/lib/session.ts`) first and scope every query by the returned `organizationId`. Get dependencies from `getContext()` (`lib/context.ts`). Validate input with zod. See `(panel)/dashboard/` for page + server action + queue, `(panel)/products/` for list/detail pages with `useActionState` forms (`components/action-form.tsx`), and `lib/domain-errors.ts` for the messages of `DomainError` codes. Server actions return `{ error }` instead of throwing for expected failures, in the request's locale. **Adding a string:** add the key to `apps/web/messages/en.json` (source of truth, keys are type-checked) and the same key to `pl.json`, then use the translator: `await getT()` in server components and actions (`@/i18n/server`), `useT()` in client components and sync ones (`@/i18n/use-t`); use ICU plurals for counts and `lib/formatters.ts` / `lib/format.ts` for dates, numbers and money. Zod schemas carry message keys (`messageKey('validation.…')`), never text. Never hard-code UI text. |
| Adding a connector | `.ai/skills/add-connector/SKILL.md`, `packages/connectors/README.md`, `packages/connector-sdk/src`. Make it available to the apps with a dependency and one line in `packages/connector-registry/src/index.ts`. Need an SDK or core change to finish? Stop and write a spec (a GitHub issue). |
| Changing auth | `apps/web/src/lib/auth.ts` (Better Auth config), `auth-client.ts`, `session.ts`, `packages/db/prisma/schema/auth.prisma`. Ask first. After changing Better Auth plugins, regenerate the reference schema with the Better Auth CLI and write a migration. |
| Changing the canonical model | `packages/connector-sdk/src/model/*`. Spec (a GitHub issue) first, ask first. Then update every mapper/connector and the DB schema that stores it. |
| Changing the Connector SDK contract | `packages/connector-sdk/src/connector.ts`. Spec (a GitHub issue) first, ask first. |
| Adding an env variable | Add to the zod schema in `packages/core/src/env.ts`, `.env.example`, the dummy env in `.github/workflows/ci.yml`, and `globalEnv` (or the task's `env`) in `turbo.json` — Turborepo's strict env mode hides undeclared variables from tasks. |
| Changing the queue | `packages/core/src/queue.ts`. Keep the `JobQueue` interface engine-neutral. |

## Architecture rules

- **Dependency direction:** `apps/*` → `@hanza/core` → `@hanza/db` (and `@hanza/core` → `@hanza/connector-sdk`); `apps/*` → `@hanza/connector-registry` → connectors → `@hanza/connector-sdk` only. The core never depends on a connector or the registry: the apps pass connector definitions into `createContext()`. Packages never import from `apps/*`. `@hanza/db` imports nothing from the workspace. `pnpm check:boundaries` enforces this.
- **Connectors** live in `packages/connectors/<id>/`, depend only on `@hanza/connector-sdk` and `zod` (`pnpm check:boundaries`), contain no UI, never touch the database, never import the core or another connector. The core hands them a `CapabilityContext` (validated config, decrypted credentials, plain `fetch` with a 30 s timeout, logger); a connector adds its own authentication to its requests, never logs credentials, and throws `ConnectorError` subclasses so the core knows whether to retry.
- **Buyer data is sealed:** an Order's Buyer data is written only through `sealBuyerData` and read through `readBuyerData` (`packages/core/src/privacy`). Never add a plaintext column, query argument, Event payload or log field that holds it (ADR 0011).
- **Tenant scoping:** an organization is the tenant. Every tenant-owned table has `organizationId`; every panel page/route/action takes it from `requireTenant()`; every job payload carries it. Never trust an `organizationId` from client input.
- **Queue behind an interface:** callers use `JobQueue` from the context, never `bullmq` directly (only `packages/core/src/queue.ts` touches it; the worker calls `startWorker`). Temporal is deliberately postponed; the interface exists so it can be swapped in later.
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

## Code style

TypeScript strict, ESM. No semicolons, single quotes, trailing commas in multi-line literals, 2-space indent, `import type` for types (`verbatimModuleSyntax`). Small focused files; one concept per file. Comments only explain *why* (a constraint, a gotcha), not what. Names: files `kebab-case.ts`, job names `domain.action`, connector ids lowercase slugs. Code, identifiers and docs are in English; the panel's copy is translated through the message catalogues (English default, Polish second).

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context: a root `CONTEXT-MAP.md` points to per-package `CONTEXT.md` files; system-wide ADRs in `docs/adr/`. See `docs/agents/domain.md`.
