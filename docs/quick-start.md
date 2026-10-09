# Quick start

This guide starts a local Hanza installation with a web app, worker, PostgreSQL and Redis. It uses only simulated connectors.

## Requirements

- Node.js **22 or newer**; CI uses **24**.
- pnpm **10.34.6**, selected by `packageManager` in the root `package.json`.
- Docker with the Compose plugin and a running Docker daemon.
- Git and OpenSSL.
- Free ports **3000**, **5442** and **6389**.

## Install and configure

```sh
git clone https://github.com/evelumo/hanza.git
cd hanza
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
```

If Corepack is unavailable in your Node installation, install/enable it or install the exact pinned pnpm version before continuing.

Generate two independent values:

```sh
openssl rand -base64 32
openssl rand -base64 32
```

Edit `.env`: set `BETTER_AUTH_SECRET` to one value and `HANZA_ENCRYPTION_KEY` to the other. Keep the file private and never commit it.

| Variable | Local value / purpose |
| --- | --- |
| `DATABASE_URL` | `postgresql://hanza:hanza@localhost:5442/hanza` |
| `REDIS_URL` | `redis://localhost:6389` |
| `BETTER_AUTH_URL` | `http://localhost:3000`, the browser-facing origin |
| `BETTER_AUTH_SECRET` | Generated authentication secret |
| `HANZA_ENCRYPTION_KEY` | Base64 encoding of exactly 32 bytes; seals credentials and Buyer data |
| `HANZA_TEST_DATABASE_URL` | Local Postgres server where tests may create/drop throwaway databases |

Web, worker and Prisma read the root `.env`. Existing process environment values take precedence. The commented settings in [`.env.example`](../.env.example) include worker concurrency and optional connector installation settings.

## Start Hanza

Run from the repository root:

```sh
pnpm infra:up
pnpm db:generate
pnpm db:deploy
pnpm dev
```

`infra:up` waits for Postgres and Redis health checks. `db:generate` creates the Prisma client; `db:deploy` applies checked-in migrations. `dev` runs both Next.js and the worker in watch mode.

Open **http://localhost:3000**, sign up and create your company during onboarding. The company is the tenant. There is no pre-created demo user or password. Choose English or Polish with the header language switcher.

In another terminal, check dependencies:

```sh
curl --fail http://localhost:3000/api/health
```

A healthy response is `{"status":"ok","database":"ok","queue":"ok"}` with HTTP 200. A failed dependency returns HTTP 503. This endpoint checks the database and queue connection; it does **not** prove a worker is consuming jobs. Try a Test channel using the [demo walkthrough](demo.md) to exercise that path.

## Stop and restart

Stop `pnpm dev` with Ctrl-C, then:

```sh
pnpm infra:down
```

Compose keeps its named data volumes. Start again with `pnpm infra:up` and `pnpm dev`. Do not remove volumes unless you intend to delete local data. Preserve the encryption key across restarts.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Docker connection error | Start Docker and retry `pnpm infra:up` |
| Port already in use | Check existing services. Compose supports `HANZA_POSTGRES_PORT` / `HANZA_REDIS_PORT` overrides; update the database/test/Redis URLs to match. For another web port, also update `BETTER_AUTH_URL` |
| Invalid environment / key | Fill both secrets; `HANZA_ENCRYPTION_KEY` must decode to exactly 32 bytes |
| Prisma client missing | Run `pnpm db:generate` after installing dependencies |
| Missing table / column | Run `pnpm db:deploy`; keep web and worker on the same revision |
| Sync requested, no result | Verify worker output, Redis connectivity and matching configuration; refresh the Connection page |
| Test OAuth channel “not set up” | Enable its demo installation settings as described in [the demo](demo.md#optional-oauth-demo), then restart web and worker |
| Browser test exits without running | Check its skip message, test database URL and installed Chromium; see [testing](testing.md) |

For upgrades and deployments, continue with [self-hosting](self-hosting.md). For bug reports, use [the support guide](../SUPPORT.md).
