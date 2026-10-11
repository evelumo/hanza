# Self-hosting

Hanza can run on infrastructure you control. It is currently an early-stage application with one real connector (WooCommerce) and simulated ones; this guide describes the runtime and operator responsibilities, not a certified production deployment recipe.

## Runtime components

| Component | Role |
| --- | --- |
| Next.js web process | Panel, authentication routes and health endpoint |
| Worker process | Jobs, sync, sign-in, workflows and scheduled privacy work |
| PostgreSQL | Domain data, auth, Events, workflow state and sealed values |
| Redis | BullMQ jobs and shared connector request limits |

The checked-in Compose file starts **Postgres and Redis only**, with named volumes and local-development credentials. There is no application Docker image or complete deployment bundle in this repository. Use a process supervisor/container setup of your choice for the two application processes, with the same checkout and configuration.

## Configuration

Use Node.js 22+ and the pinned pnpm version. Supply the root `.env` or process environment securely. Set:

- `DATABASE_URL` and `REDIS_URL` to your protected services.
- `BETTER_AUTH_URL` to the exact public origin, including `https://` when served through TLS.
- An independently generated `BETTER_AUTH_SECRET` and `HANZA_ENCRYPTION_KEY`.
- Any required connector installation settings. The current OAuth connector is simulated; real providers are planned.

Web and worker must agree on the database, Redis, encryption key and queue namespace. Leave `HANZA_QUEUE_PREFIX` unset for the ordinary installation; the E2E runner sets its own prefix. `WORKER_CONCURRENCY` is a positive integer, default 10.

The worker executes TypeScript from source with `tsx`, and workspace packages export source. Keep the checkout and its runtime dependencies available; do not copy only the `.next` directory and expect a complete installation.

## Prepare and start

From the repository root, with configuration and data services ready:

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:deploy
pnpm build
```

Run these as **two separately supervised processes**:

```sh
pnpm --filter @hanza/web start
```

```sh
pnpm --filter @hanza/worker start
```

For an external deployment, configure `NODE_ENV=production`, TLS termination, process restarts, log handling and private network access to Postgres/Redis. Do not expose the development Compose services with their example credentials on a public network. Redis must preserve queue keys: the local configuration uses append-only persistence and `noeviction`.

## Verify progress

Check `/api/health`: HTTP 200 means database and queue connections work; HTTP 503 means a dependency failed. Inspect worker output for `worker ready` and completed jobs. A sync requested in the panel should produce sync results after a refresh. The health endpoint alone does not detect an absent worker or prove connector success.

Monitor failing Connection health, push rejections and worker errors. Avoid logs containing credentials or Buyer data.

## Backups and encryption key

Back up PostgreSQL and the installation's secret configuration securely; preserve Redis data where needed for queue continuity. Test restoration in an isolated environment.

`HANZA_ENCRYPTION_KEY` seals both Connection credentials and Buyer data. A database backup without the matching key cannot recover those values. Replacing/loss of the key makes existing sealed data unreadable; signing in to a connector again restores credentials but does not recover historical Buyer snapshots. Key rotation is not implemented.

## Upgrade

1. Review the target revision's migrations and affected ADRs. Back up data and the matching secrets.
2. Stop web and worker together so old code cannot use a partially changed schema.
3. Update the checkout, install pinned dependencies and generate the Prisma client.
4. Run `pnpm db:deploy`, then `pnpm build`.
5. Start web and worker from the same new revision and check health plus background progress.

Some migrations hold exclusive table locks and are incompatible with code on the other side, such as [the Order statuses migration](adr/0018-order-statuses-are-labels-within-fixed-phases.md). A rolling upgrade is not generally safe. Do not hand-edit applied migrations. A code-only rollback may fail after a schema migration; plan restoration with the compatible data, secrets and revision.

Development and test resources should be separate from an operated installation. `HANZA_TEST_DATABASE_URL` belongs on a disposable test server with create/drop privileges, not a production URL.
