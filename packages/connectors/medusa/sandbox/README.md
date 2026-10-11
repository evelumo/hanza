# Medusa recording sandbox

A throwaway Medusa store with `medusa-plugin-hanza`, in Docker. It exists to record the connector's test fixtures
(`packages/connectors/README.md`, "Recorded fixtures"): tests replay the cassettes, and CI never starts it.
Everything in it is invented; lose it whenever you like.

Pinned: Medusa **2.21.2** (`app/package.json`), Node 22 (`node:22-alpine`), `postgres:17-alpine`, `redis:7-alpine`. The
plugin comes from a tarball of its repository (`evelumo/medusa-plugin-hanza`), never from npm, so a recording names the
plugin version it was made with (`plugin.version` in every answer of its routes).

**Not run yet.** The plugin was being written when this sandbox was; nothing here has started a container. The commands,
the seed and the request shapes are written from Medusa's documentation and its default seed script. The first person
to run it: fix what breaks, then tick off the items in `../AGENTS.md`, "To verify in the sandbox".

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
| `key` | Signs in as the admin (`POST /auth/user/emailpass`), makes a secret API key (`POST /admin/api-keys`, `type: secret`) and writes `{ sandboxUrl, apiKey }` to `../.recording/credentials.json` (git-ignored). `tools/key.mjs`; the key never appears on a command line or in the output. |
| `reset` | `down`, `up`, `seed`, `key`. |
| `down` | Removes the containers, the volumes and the keys file. |
| `curl <path> [curl args]` | `curl` against `/admin/<path>` with the secret key (given to curl on its standard input, never on its command line), e.g. `$S curl 'hanza/status'`, `$S curl 'hanza/journal?after=0&limit=10'`. |
| `status` | Lists the containers. |
| `exec <command>` | Runs a command in the medusa container. |

Ports, on 127.0.0.1 only and away from the defaults (Hanza's own Postgres and Redis are on 5442 and 6389): Medusa
**9100**, Postgres **5443**, Redis **6390** (`MEDUSA_SANDBOX_PORT`, `MEDUSA_SANDBOX_POSTGRES_PORT`,
`MEDUSA_SANDBOX_REDIS_PORT`). The compose project is `hanza-medusa-sandbox` (`MEDUSA_SANDBOX_PROJECT`). The admin UI is
off (`MEDUSA_DISABLE_ADMIN`); `MEDUSA_SANDBOX_DISABLE_ADMIN=false $S up` turns it on at http://127.0.0.1:9100/app to look
at Extensions → Hanza.

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

The connector's cassettes are **provisional** until this is done (`../AGENTS.md`, "Tests and cassettes"):

```sh
S=packages/connectors/medusa/sandbox/sandbox.sh
$S pack && $S reset
sleep 10       # the journal shows entries older than 5 s only; let the seed's settle
HANZA_RECORD_FIXTURES=1 pnpm --filter @hanza/connector-medusa exec vitest run src/connector.test.ts
$S down
```

- Run the file directly, not through `pnpm test`: Turborepo hides `HANZA_RECORD_FIXTURES`. Without
  `MEDUSA_RECORDING_SOURCE`, the recording setup (`src/testing/recording.ts`) reads `../.recording/credentials.json` and
  sends requests for `https://medusa.example.test` to the sandbox, turning `''` under scrubbed keys into `null` (#128).
- The conformance kit pushes stock of 0 and 5 to the first three Offers and moves the first Order it gets in full
  through every phase (a fulfillment and a shipment of order 1 or 2; the cancel is refused, the order is shipped). After
  it the seed is no longer the seed: `reset` before recording again.
- The kit's C18 asks the journal for `after=1` and expects 410 `journal_expired`: on a fresh store nothing was pruned,
  so this needs the retention job to have pruned past seq 1 first (for example set `journal_retention_days` to its
  minimum and run the plugin's job, or delete the first entries and record `pruned_through_seq`; whatever the plugin
  offers), or a test change that records C18 from a scenario of its own. To decide when the plugin exists.
- Read the diff: no `127.0.0.1`, no port, no key, no `Authorization`, no name, address, phone or e-mail but the
  placeholders. Then replay without the variable.
- `.recording/` must never be committed, and holds nothing once you are done (`down` removes the keys file).
