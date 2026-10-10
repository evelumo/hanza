# Development

Set up the repository using [the quick start](quick-start.md). Read [CONTRIBUTING.md](../CONTRIBUTING.md) before changing contracts or domain behaviour.

## Commands

Run from the repository root:

| Command | Purpose |
| --- | --- |
| `pnpm infra:up` / `pnpm infra:down` | Start/stop local Postgres and Redis; named volumes persist |
| `pnpm dev` | Run web and worker in watch mode through Turborepo |
| `pnpm db:generate` | Generate the Prisma client; no database needed |
| `pnpm db:deploy` | Apply existing migrations |
| `pnpm db:migrate` | Create/apply a development migration after a schema change |
| `pnpm check:boundaries` | Enforce connector dependency rules |
| `pnpm typecheck` | Type-check workspaces; web generates Next.js route types first |
| `pnpm test` | Run Vitest tests; database/Redis layers have prerequisites |
| `pnpm build` | Build the Next.js app; worker runs TypeScript source |
| `pnpm test:e2e` | Run the isolated local Playwright panel suite |

For focused package tests, use an existing workspace script, for example:

```sh
pnpm --filter @hanza/connector-fake test
```

The workspace packages are private and consumed from source; they are not an npm installation interface. `pnpm generate`, `pnpm create-connector` and `pnpm test:connector <id>` are planned commands, not available scripts.

## Configuration

The root `.env` is shared by web, worker and Prisma. Turborepo uses strict environment handling, so adding a core variable requires updates to the core env schema, `.env.example`, CI dummy env and Turborepo's declared env. CI/Turborepo changes require approval under [AGENTS.md](../AGENTS.md).

Connector installation settings follow `HANZA_CONNECTOR_<ID>_<FIELD>` from their `appConfigSchema`. They are passed through to `dev` without entering a cache key. Missing required settings leave the connector listed as “not set up”. Restart web and worker after changing them. See [the connector guide](../packages/connectors/README.md).

Before changing Turborepo configuration or commands, resolve the installed package with `node -p "require.resolve('turbo/package.json')"` and read its `docs/README.md`, then the relevant bundled page. The repository's managed agent-guidance block documents this requirement.

## Common change paths

| Change | Start here |
| --- | --- |
| Panel page/action | `apps/web/src/app`, `requireTenant()`, `getContext()`, the kit in `apps/web/src/components` (the Orders pages are the reference) and the English/Polish message catalogues |
| Domain logic | `packages/core/src`, its glossary and relevant ADRs |
| Database model | `packages/db/prisma/schema/<module>.prisma`, Organization back-relation and a new migration |
| Background job | `defineJob`, core registry and exports; payload includes `organizationId` |
| Multi-step work | `defineWorkflow` with short, idempotent named steps; register/export the definition |
| Connector | SDK contract, reference connectors and the add-connector skill |
| Browser flow | `apps/e2e/flows`, using its shared fixtures and accessible locators |

The [task router in AGENTS.md](../AGENTS.md#task-router) contains the detailed requirements. Read [the domain map](../CONTEXT-MAP.md) and relevant [ADRs](adr/) before editing an area.

## Documentation changes

Keep commands aligned with `package.json`, describe only implemented features as available, and label future APIs/connectors **planned**. Update the root README when the product's stage changes and the package README when its responsibility or interface changes.

Follow relative links from the changed page and check headings used as anchors. Documentation-only changes need no new runtime tests, but still follow the repository's applicable validation gate and report checks actually run.
