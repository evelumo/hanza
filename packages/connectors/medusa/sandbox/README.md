# Medusa recording sandbox

A throwaway Medusa store with `medusa-plugin-hanza`, in Docker. It exists to record the connector's test fixtures
(`packages/connectors/README.md`, "Recorded fixtures"): tests replay the cassettes, and CI never starts it.
Everything in it is invented; lose it whenever you like.

Pinned: Medusa **2.21.2** (`app/package.json`), Node 22 (`node:22-alpine`), `postgres:17-alpine`, `redis:7-alpine`. The
plugin comes from a tarball of its repository (`evelumo/medusa-plugin-hanza`), never from npm, so a recording names the
plugin version it was made with (`plugin.version` in every answer of its routes).

Run on 2026-10-11 (macOS, Docker 29): the image builds in a few minutes, the seed and the key take seconds, and the
recordings in `../src/fixtures/` come from it. To look at the plugin's settings page, start it with the admin on (below).

## Commands

Run from anywhere; needs Docker and Node.

```sh
S=packages/connectors/medusa/sandbox/sandbox.sh
$S pack                 # build the plugin next to this checkout (../medusa-plugin-hanza) and copy its tarball into plugin/
$S reset                # down, up, seed, key: a fresh, seeded store with a secret API key
```

| Command | What it does |
| --- | --- |
| `pack [dir]` | Builds the plugin (`npm run build`, then `npm pack`) in `dir` (default: `medusa-plugin-hanza` beside this repository's checkout) and puts `medusa-plugin-hanza-<version>.tgz` in `plugin/` (git-ignored). The image refuses to build without it. |
| `up` | Builds the image (the app in `app/`, the plugin from the tarball), starts Postgres, Redis and Medusa, which runs `npx medusa db:migrate` (Medusa's and the plugin's migrations), creates the admin `hanza@example.com` (`npx medusa user`) and starts `medusa develop`. Waits for `/health`. Safe to repeat. |
| `seed` | Runs `npx medusa exec ./src/scripts/seed.ts` in the container (below). Once per store: a second run is refused. |
| `prune` | Prunes the plugin's whole journal (`app/src/scripts/prune.ts`, which asks the plugin's service for everything older than 0 days) and touches the newest order (`POST /admin/orders/<id>` with a metadata key, an `order.updated` entry), so the journal has one entry to start from and a position before the prune answers 410 `journal_expired`: what the conformance kit's check C18 records. |
| `key` | Signs in as the admin (`POST /auth/user/emailpass`), makes a secret API key (`POST /admin/api-keys`, `type: secret`) and writes `{ sandboxUrl, apiKey }` to `../.recording/credentials.json` (git-ignored). `tools/key.mjs`; the key never appears on a command line or in the output. |
| `reset` | `down`, `up`, `seed`, `key`. |
| `down` | Removes the containers, the volumes and the keys file. |
| `curl <path> [curl args]` | `curl` against `/admin/<path>` with the secret key (given to curl on its standard input, never on its command line), e.g. `$S curl 'hanza/status'`, `$S curl 'hanza/journal?after=0&limit=10'`. |
| `status` | Lists the containers. |
| `exec <command>` | Runs a command in the medusa container. |
| `tls` | Opt-in: nginx with a throwaway certificate in front of the store, `https://medusa.example.test:9443`, and prints what a local Hanza worker needs to reach it (below, "A TLS front"). |
| `tls-env` | Prints that environment again. |
| `tls-curl …` | `curl` through the TLS front (the certificate trusted, the name sent to this machine), e.g. `$S tls-curl -i https://medusa.example.test:9443/health`. |

Ports, on 127.0.0.1 only and away from the defaults (Hanza's own Postgres and Redis are on 5442 and 6389): Medusa
**9100**, Postgres **5443**, Redis **6390** (`MEDUSA_SANDBOX_PORT`, `MEDUSA_SANDBOX_POSTGRES_PORT`,
`MEDUSA_SANDBOX_REDIS_PORT`). The compose project is `hanza-medusa-sandbox` (`MEDUSA_SANDBOX_PROJECT`). The admin UI is
off (`MEDUSA_DISABLE_ADMIN`); `MEDUSA_SANDBOX_DISABLE_ADMIN=false $S up` turns it on at http://127.0.0.1:9100/app to look
at the Hanza page in its sidebar.

## The app

`app/` is a minimal Medusa application: `package.json` (Medusa pinned), `medusa-config.ts` with
`plugins: [{ resolve: "medusa-plugin-hanza" }]`, the Redis event bus and workflow engine (the plugin's subscribers run
on the event bus, as on a store in production), `tsconfig.json`, and the seed. No lockfile: the image runs
`npm install`, and only Medusa's own packages are pinned exactly.

## The seed

`app/src/scripts/seed.ts`, run while the server is up. The catalogue goes in through Medusa's workflows; the orders go
through the Store API as a Buyer's would (cart, shipping method, payment collection, `pp_system_default` session,
complete), and the payments, fulfillments and cancels through the Admin API, so the plugin's subscribers see the events
a real store emits and its journal fills.

- Region **Poland** (PLN, country `pl`, payment provider `pp_system_default`), tax region `pl`, PLN the store's only and
  default currency.
- Sales channel **Hanza sandbox web shop** (the store's default from now on; Medusa's own default channel stays, empty),
  a publishable key for it, a stock location **Hanza sandbox warehouse** linked to it, a fulfillment set for Poland and a
  manual shipping option **Standard shipping** (15 PLN).
- Six products, 100 units of each managed variant at the location:

  | Product | Variants (SKU) | Price | Note |
  | --- | --- | --- | --- |
  | Mug | `MUG-1` | 49.99 | |
  | T-shirt | `TSHIRT-S`, `TSHIRT-M` | 79 | two variants of one product |
  | Gift card 50 | `GIFT-50` | 50 | `manage_inventory: false`: a stock push answers `inventory_not_managed` |
  | Coming soon poster | `SOON-1` | 29 | unpublished (draft): an `inactive` Offer |
  | Notebook | `NOTE-1` | 19.90 | |
  | Pen | `PEN-1` | 4.99 | |

- Five orders, in this order:

  | # | Lines | State | What the feed makes of it |
  | --- | --- | --- | --- |
  | 1 | Mug ×1 | payment authorized, not captured | open, awaiting payment (`paid_when: captured`) |
  | 2 | Notebook ×2 | captured | open, paid |
  | 3 | Pen ×3 | captured, fulfilled and shipped | closed: an Order update with `paid` and `shipped` |
  | 4 | T-shirt S ×1 | cancelled before capture | not listed (status `canceled`) |
  | 5 | Mug ×1, T-shirt M ×2 | captured | open, paid, two lines |

- The plugin's settings (`POST /admin/hanza/settings`): the stock location above, every sales channel, no pay-on-delivery
  provider (every sandbox order is prepaid; cash on delivery is covered by the in-memory tests), `paid_when: captured`,
  no e-mail on shipment, prices in the store's currency.

## Recording

All three cassettes, in this order, from a fresh store (what `../src/fixtures/` holds was recorded this way on 2026-10-11):

```sh
S=packages/connectors/medusa/sandbox/sandbox.sh
$S pack && $S reset
$S prune                     # the journal pruned, one entry left: what C18 needs
sleep 10                     # the journal shows entries older than 5 s only
HANZA_RECORD_FIXTURES=1 pnpm --filter @hanza/connector-medusa exec vitest run src/connector.test.ts

# Then the changes the journal scenario expects: order 2 cancelled (Medusa refunds it), order 1's payment captured.
O1=$($S curl 'orders?order=created_at&limit=1&fields=id' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).orders[0].id))')
O2=$($S curl 'orders?order=created_at&limit=2&fields=id' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).orders[1].id))')
P1=$($S curl "orders/$O1?fields=id,*payment_collections.payments" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).order.payment_collections[0].payments[0].id))')
$S curl "orders/$O2/cancel" -X POST >/dev/null
$S curl "payments/$P1/capture" -X POST -H 'Content-Type: application/json' -d '{}' >/dev/null
sleep 10
HANZA_RECORD_FIXTURES=1 pnpm --filter @hanza/connector-medusa exec vitest run src/capabilities/orders-pull.recorded.test.ts
$S down
```

- Run the files directly, not through `pnpm test`: Turborepo hides `HANZA_RECORD_FIXTURES`. Without
  `MEDUSA_RECORDING_SOURCE`, the recording setup (`src/testing/recording.ts`) reads `../.recording/credentials.json` and
  sends requests for `https://medusa.example.test` to the sandbox, turning `''` under scrubbed keys into `null` (#128).
- The conformance kit pushes stock of 0 and 5 to the first three Offers (the gift card, which manages no inventory, is
  reported `inventory_not_managed`) and ships the first Order it gets in full (order 1: a fulfillment and a shipment;
  its cancel is refused by the connector since the order is shipped). After it the seed is no longer the seed: `reset`
  before recording again.
- The journal scenario resumes from the position and boundary the conformance cassette ends with, so the two must be
  recorded together, in this order, with nothing else changing the store in between but the two calls above.
- Read the diff: no `127.0.0.1`, no port, no key, no `Authorization`, no name, address, phone or e-mail but the
  placeholders (`scrubbed-N`, `person-N@example.com`, `+0000000000N`). Then replay without the variable.
- `.recording/` must never be committed, and holds nothing once you are done (`down` removes the keys file).

## A TLS front

The recording flow talks to the store over plain HTTP and rewrites the address in the test transport. To run the real
application against the store (the core's `ctx.fetch`, the rate limiter, the scheduler, the panel), the store has to
be reachable the way a real one is: `https://medusa.example.test:<port>` → nginx, which ends TLS → Medusa over HTTP
with `X-Forwarded-Proto: https`. It is opt-in and changes nothing of the plain port or the recording flow: `up`,
`seed`, `key`, `prune`, `reset` and `curl` work as before, with or without it.

```sh
S=packages/connectors/medusa/sandbox/sandbox.sh
MEDUSA_SANDBOX_DISABLE_ADMIN=false $S reset   # the store, with its admin at http://127.0.0.1:9100/app
$S tls                                        # certificate, nginx, and the lines below
$S tls-curl -i https://medusa.example.test:9443/health
$S down                                       # removes the front, its certificate and its log too
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `MEDUSA_SANDBOX_TLS_PORT` | `9443` | Host port of the front, bound to 127.0.0.1 only. Give each instance its own, like `MEDUSA_SANDBOX_PORT`. |
| `MEDUSA_SANDBOX_RESOLVE` | unset | Read by `resolve-store.mjs` (below), not by the script: the host names to answer with 127.0.0.1. |

What `tls` sets up:

- **nginx** (`nginx:1.30.0-alpine`, the Compose service `tls` behind the profile `tls`, config in `nginx/store.conf`):
  TLS 1.2 and 1.3, HTTP/2 offered, gzip on, `X-Forwarded-Proto: https` set by nginx whatever the client sends, and
  Medusa looked up again on every request, so the front answers **502** while the store is stopped and works again
  once it is back. `tls` starts the front without touching the store (`--no-deps`), so a store started with
  `MEDUSA_SANDBOX_DISABLE_ADMIN=false` keeps its admin.
- **A certificate** for `medusa.example.test`, signed by a certificate authority made for this instance with `openssl`.
  The authority may sign for that name only (a name constraint), its private key is deleted as soon as the certificate
  is signed, and both expire after 30 days. Everything is in `../.recording/tls[.<project>]/` (git-ignored, never
  commit it): `ca.crt`, `cert/server.crt`, `cert/server.key`.
- **An access log**, one JSON object per request, in `../.recording/tls[.<project>]/log/access.log` and in
  `docker compose -p <project> logs tls`: time, method, path with its query, status, bytes, duration, TLS version, and
  whether an `Authorization` header came (`basic`, `other`, `none`), never its value. It is the audit of what the
  connector really sends: a key in a URL would show in `uri`.

### Pointing a locally running Hanza at it

The connector accepts only a public-looking `https://` address (`../src/settings.ts`), so the store keeps its name and
the name is made to resolve to this machine **in the worker process only**: `resolve-store.mjs`, preloaded with
`node --import`, answers `dns.lookup` for the names in `MEDUSA_SANDBOX_RESOLVE` with 127.0.0.1 and leaves every other
name alone. No `/etc/hosts`, no sudo, no DNS service. Node trusts the certificate through `NODE_EXTRA_CA_CERTS`.
`tls-env` prints the three variables:

```sh
eval "$($S tls-env)"                    # NODE_EXTRA_CA_CERTS, MEDUSA_SANDBOX_RESOLVE, NODE_OPTIONS=--import=…/resolve-store.mjs
pnpm --filter @hanza/worker dev         # in that shell. Not `pnpm dev`: Turborepo hides variables it was not told about
pnpm --filter @hanza/web dev            # in another shell; the web app never calls the store and needs none of them
```

Then add a Medusa Connection in the panel with the address `tls` printed (`https://medusa.example.test:9443`) and the
`apiKey` from `../.recording/credentials.json`. Only the worker calls the store. Use a database and a
`HANZA_QUEUE_PREFIX` of your own if the default ones hold data you care about (`apps/e2e/src/run.ts` shows how a run
isolates itself): the first sync imports the seed's open orders.

To act as the merchant, sign in to the admin at http://127.0.0.1:9100/app as `hanza@example.com` with
`hanza-sandbox-password` (docker-compose.yml): the Hanza page is in its sidebar, orders can be fulfilled, captured and
cancelled there, and every change reaches Hanza through the plugin's journal on the next `sync.tick`. To act as a
Buyer, the seed's `app/src/scripts/seed.ts` shows the Store API calls that place an order (a publishable key, a cart
in the region, a shipping method, the manual payment provider, complete).
