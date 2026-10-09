# Contributing to Hanza

Hanza welcomes documentation, bug fixes, tests and connector contributions. Start with the [quick start](docs/quick-start.md), [architecture](docs/architecture.md) and [AGENTS.md](AGENTS.md). The agent guide is also the repository's engineering contract for human contributors.

## Choose a task

Search [existing issues](https://github.com/evelumo/hanza/issues) before opening a new one. Describe bugs with reproduction steps; discuss feature requests in an issue before sending an implementation PR. The [triage labels](docs/agents/triage-labels.md) distinguish issues needing information from work ready for a person or an agent.

Good initial contributions include improving a setup instruction, reducing a bug to a deterministic test, or fixing translated copy in both message catalogues.

## Decide whether a spec is needed

Bug fixes, refactors without contract changes, copy changes and connectors that fit the existing SDK do not need a spec.

A non-trivial change starts with a **GitHub issue titled `Spec: <topic>`**, reviewed before implementation. This includes new modules or DB models, public APIs or capabilities, production dependencies, and changes to auth, tenancy, Stock or sync semantics, the job/queue contract, the canonical model, SDK contract or `createContext()` shape.

Include these sections in the issue:

- Summary; problem and non-goals.
- Proposed design: affected packages/files, failure modes, idempotency and alternatives.
- Data model and SDK/API changes, or “None”.
- Tenant and security considerations.
- Test plan and rollout.
- Open questions.

Follow [the issue tracker guide](docs/agents/issue-tracker.md). Keep the issue current, link it from implementation PRs, and close it with the shipped PR links. Specs live in issues, decisions in [ADRs](docs/adr/), vocabulary in [CONTEXT.md files](CONTEXT-MAP.md).

Obtain explicit approval for the areas listed under **Ask first** in [AGENTS.md](AGENTS.md): production dependencies, canonical/SDK contracts, Better Auth, Stock-reservation or inventory-sync logic, and Turborepo, CI or Compose changes. A proposed design still needs review even if an agent can implement it.

## Make the change

1. Fork the repository or use your contributor checkout. Create a focused branch from `main`, such as `docs/setup` or `fix/order-filter`.
2. Read the relevant package's `AGENTS.md`, domain glossary and ADRs.
3. Keep the change focused. Preserve unrelated local work and avoid generated files or secret values in the diff.
4. Add deterministic Vitest coverage for logic. New panel screens or flows also get a [Playwright flow](apps/e2e/README.md).
5. Update affected documentation and run the relevant validation gate.

Code and documentation are in English. Panel copy belongs in `apps/web/messages/en.json` and `pl.json`; use the translators and shared formatters rather than hard-coded strings. TypeScript uses strict ESM, two-space indentation, single quotes, no semicolons and `import type` for types.

## Respect the boundaries

- Panel pages, routes and actions take the organization from `requireTenant()`. Scope every tenant query with that `organizationId`; never accept it from client input.
- Connectors depend only on `@hanza/connector-sdk` and zod. They contain no UI and never access the database or core.
- Use `JobQueue` and `ctx.workflows` for background work. Jobs and workflow step effects must be idempotent.
- Write/read Buyer data through the privacy services. Money is a decimal string plus ISO currency.
- Commit a migration for each schema change. Never edit an applied migration or `packages/db/src/generated`.

For a connector, follow the [connector guide](packages/connectors/README.md) and [add-connector skill](.ai/skills/add-connector/SKILL.md). If it needs a core or SDK change, stop and write a spec.

## Validate

Run the smallest relevant subset, in this order:

```sh
pnpm db:generate        # fresh checkout or Prisma schema changes
pnpm check:boundaries   # connector changes
pnpm typecheck
pnpm test
pnpm build             # web or shared configuration changes
```

After a panel screen or flow change, run `pnpm test:e2e`. Run the browser suite **three times before opening a PR** for such a change, as required by [AGENTS.md](AGENTS.md). A skipped browser run is not a pass. See [testing](docs/testing.md) for database/Redis prerequisites and retained failure evidence.

## Open a pull request

Target `main`. Explain the problem and resulting behaviour, link the issue/spec, and list validation actually performed. Include screenshots or recordings for visible UI changes and migration/rollout notes when applicable. Name skipped checks and missing runtime evidence explicitly.

AI assistance is welcome. The contributor remains responsible for understanding the diff, reviewing generated code, running checks and keeping claims accurate. Do not include tokens, credentials, Buyer data or unreviewed recorded traffic.

## Questions and security

Ask development questions in [GitHub Issues](https://github.com/evelumo/hanza/issues) with the relevant command, version and sanitized output. Use [SECURITY.md](SECURITY.md) for vulnerabilities; do not publish exploit details in an issue or PR.
