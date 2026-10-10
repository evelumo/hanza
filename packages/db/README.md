# @hanza/db

Prisma schema, migrations, generated client and database test helpers. This package imports no other workspace package.

## Layout

- `prisma/schema/*.prisma`: schema split by module; `base.prisma` holds generator/datasource configuration.
- `prisma/migrations`: versioned SQL migrations.
- `src/index.ts`: client factory/export surface. `createDb` is the only way a client is made: it pins every session's time zone to UTC (`withUtcSession`), whatever the server, the database, the role or `DATABASE_URL` asks for. `DateTime` columns are `timestamp` without a zone holding UTC, and services compare them with SQL's `now()`; in a session with another zone those comparisons, and every `now()` read through Prisma, are off by the offset ([ADR 0023](../../docs/adr/0023-a-shipment-row-is-its-own-request-and-its-label-is-fetched-by-the-worker-and-sealed.md)).
- `src/testing.ts`: throwaway database helpers, exported as `@hanza/db/testing`.
- `src/generated`: generated, git-ignored Prisma client; never hand-edit it.

Prisma reads the root `.env` through `prisma.config.ts`. Run commands from the repository root:

```sh
pnpm db:generate   # no database required
pnpm db:deploy     # apply existing migrations
pnpm db:migrate    # create/apply a development migration after schema edits
```

## Schema rules

Tenant-owned records carry `organizationId`, a relation to Organization and an index starting with it. Add the back-relation in `auth.prisma`. Better Auth owns its auth tables; changes to them require approval. Every schema change includes a new migration; applied migrations are immutable.

Database-backed tests create a database on `HANZA_TEST_DATABASE_URL`, apply all migrations and drop it afterwards. The test server must permit create/drop operations and be separate from production.

Read [CONTRIBUTING.md](../../CONTRIBUTING.md), relevant [ADRs](../../docs/adr/) and [self-hosting upgrade guidance](../../docs/self-hosting.md#upgrade). Some migrations require web and worker to be stopped together.
