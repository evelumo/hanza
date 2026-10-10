# WooCommerce recording sandbox

A throwaway WordPress + WooCommerce in Docker. It exists to record the connector's test fixtures
(`packages/connectors/README.md`, "Recorded fixtures"): tests replay the cassettes, and CI never starts it.
With its opt-in [TLS front](#a-tls-front) it is also a shop a locally running Hanza can connect to for real.
Everything in it is invented; lose it whenever you like.

Pinned: WordPress 7.1.3 (`wordpress:7.1.3-php8.3-apache`), WooCommerce 11.2.1, MariaDB 11.8.9, wp-cli 2.12.0,
and for the TLS front nginx 1.30.0 (`nginx:1.30.0-alpine`).

## Commands

Run from anywhere; needs Docker and Node (and `openssl` for `tls`).

```sh
packages/connectors/woocommerce/sandbox/sandbox.sh reset    # a fresh, seeded shop with API keys: down, up, seed, key
```

| Command | What it does |
| --- | --- |
| `up` | Starts the containers, installs WordPress and WooCommerce, applies the shop settings. Safe to repeat. |
| `seed` | Creates the seed products and orders. Once per shop: a second run is refused. |
| `key` | Creates the REST API keys and writes them to `../.recording/credentials.json` (git-ignored). Replaces earlier keys. |
| `reset` | `down`, `up`, `seed`, `key`. About 50 s with the images already pulled. |
| `down` | Removes the containers, the volumes and the keys file. |
| `wp <args>` | Runs wp-cli in the shop, to script a scenario. |
| `curl <path> [curl args]` | `curl` against `wp-json/wc/v3/<path>` with the read-write key. The key goes to curl on its standard input, never on its command line (where `ps` would show it), so `-d @-` is not available. |
| `status` | Lists the containers. |
| `tls` | Opt-in: puts nginx with a throwaway certificate in front of the shop and prints how to reach it. See [A TLS front](#a-tls-front). |
| `tls-env` | Prints, as shell to `eval`, the environment a local Hanza worker needs to reach the TLS front. |
| `tls-curl <curl args>` | `curl` through the TLS front (the shop's host name sent to this machine, trusting the sandbox's certificate authority only). |

Scripting a scenario between two recorded calls:

```sh
sandbox.sh wp wc shop_order update 33 --status=processing --user=1   # change an order's status
sandbox.sh wp wc shop_order delete 56 --user=1                       # move an order to the trash
sandbox.sh wp wc shop_order delete 55 --force=true --user=1          # delete it for good
sandbox.sh wp option update woocommerce_manage_stock no              # turn the shop's stock management off
sandbox.sh wp eval '$o = wc_get_order(30); $o->set_customer_note("x"); $o->save();'
sandbox.sh curl 'orders?status=trash&_fields=id,status,date_modified_gmt'
```

## Two shops at once

Nothing has a fixed name, so give each instance its own project name and port:

```sh
WOO_SANDBOX_PROJECT=hanza-woo-b WOO_SANDBOX_PORT=8090 sandbox.sh reset
WOO_SANDBOX_PROJECT=hanza-woo-b WOO_SANDBOX_PORT=8090 sandbox.sh wp wc shop_order list --user=1
WOO_SANDBOX_PROJECT=hanza-woo-b WOO_SANDBOX_PORT=8090 HANZA_RECORD_FIXTURES=1 pnpm --filter @hanza/connector-woocommerce exec vitest run src/<file>.test.ts
WOO_SANDBOX_PROJECT=hanza-woo-b WOO_SANDBOX_PORT=8090 sandbox.sh down
```

The default is project `hanza-woo-sandbox` on port 8089 with keys in `.recording/credentials.json`; any other
project keeps its keys in `.recording/credentials.<project>.json`. Set the port next to the project name: a test that calls `sandbox.sh wp` refuses to run without it, because the script would fall back to the default port. The recording setup
(`src/testing/recording.ts`, `loadRecording()`) reads `WOO_SANDBOX_PROJECT` to pick the file, which also says
where that instance listens.

## A TLS front

The recording flow talks to the shop over plain HTTP and rewrites the address in the test transport. To run the
real application against the shop (the core's `ctx.fetch`, the rate limiter, the scheduler, the panel), the shop
has to be reachable the way a real one is: `https://shop.example.test:<port>` → nginx, which ends TLS → WordPress
over HTTP with `X-Forwarded-Proto: https`. It is opt-in and changes nothing of the plain port or the recording
flow: `up`, `seed`, `key`, `reset`, `wp` and `curl` work as before, with or without it.

```sh
export WOO_SANDBOX_PROJECT=hanza-woo-live WOO_SANDBOX_PORT=8095 WOO_SANDBOX_TLS_PORT=8445
sandbox.sh reset          # the shop, as always
sandbox.sh tls            # certificate, nginx, and the lines below
sandbox.sh tls-curl -i https://shop.example.test:8445/wp-json/wc/v3/
sandbox.sh down           # removes the front, its certificate and its log too
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `WOO_SANDBOX_TLS_PORT` | `8443` | Host port of the front, bound to 127.0.0.1 only. Give each instance its own, like `WOO_SANDBOX_PORT`. |
| `WOO_SANDBOX_RESOLVE` | unset | Read by `resolve-shop.mjs` (below), not by the script: the host names to answer with 127.0.0.1. |

What `tls` sets up:

- **nginx** (`nginx:1.30.0-alpine`, the Compose service `tls` behind the profile `tls`, config in `nginx/shop.conf`):
  TLS 1.2 and 1.3, HTTP/2 offered, gzip on (WordPress is asked for plain bodies, so the compression is nginx's),
  `X-Forwarded-Proto: https` set by nginx whatever the client sends, and WordPress looked up again on every request,
  so the front answers **502** while the shop is stopped (`docker stop <project>-wordpress-1`) and works again once
  it is back. `www.shop.example.test` answers **301** to the bare name, as a shop does for its other spelling. The
  `Date` header of every answer is nginx's own (it replaces the one WordPress sends).
- **A certificate** for `shop.example.test` and `www.shop.example.test`, signed by a certificate authority made
  for this instance with `openssl`. The authority may sign for those names only (a name constraint), its private
  key is deleted as soon as the certificate is signed, and both expire after 30 days. Everything is in
  `../.recording/tls[.<project>]/` (git-ignored, never commit it): `ca.crt`, `cert/server.crt`, `cert/server.key`.
- **An access log**, one JSON object per request, in `../.recording/tls[.<project>]/log/access.log` and in
  `docker compose -p <project> logs tls`: time, method, path with its query, status, bytes on the wire and before
  compression, duration, TLS version, the connection and the request's number on it, and whether an `Authorization`
  header came (`basic`, `other`, `none`), never its value. It is the audit of what the connector really sends: a key
  in a URL would show in `uri`.

### Pointing a locally running Hanza at it

The connector accepts only a public-looking `https://` address (`src/settings.ts`), so the shop keeps its name and
the name is made to resolve to this machine **in the worker process only**: `resolve-shop.mjs`, preloaded with
`node --import`, answers `dns.lookup` for the names in `WOO_SANDBOX_RESOLVE` with 127.0.0.1 and leaves every other
name alone. No `/etc/hosts`, no sudo, no DNS service. Node trusts the certificate through `NODE_EXTRA_CA_CERTS`.
`tls-env` prints the three variables:

```sh
eval "$(sandbox.sh tls-env)"            # NODE_EXTRA_CA_CERTS, WOO_SANDBOX_RESOLVE, NODE_OPTIONS=--import=…/resolve-shop.mjs
pnpm --filter @hanza/worker dev         # in that shell. Not `pnpm dev`: Turborepo hides variables it was not told about
pnpm --filter @hanza/web dev            # in another shell; the web app never calls the shop and needs none of them
```

Then add a WooCommerce Connection in the panel with the address `tls` printed (`https://shop.example.test:8445`)
and the keys from `../.recording/credentials[.<project>].json`. Only the worker calls the shop. Use a database and a
`HANZA_QUEUE_PREFIX` of your own if the default ones hold data you care about (`apps/e2e/src/run.ts` shows how a run
isolates itself): the first sync imports the seed's open orders.

To act as a Buyer, use the Store API through the front (`sandbox.sh tls-curl … /wp-json/wc/store/v1/cart`, with the
`Cart-Token` and `Nonce` headers it answers with), or a real browser started with
`--host-resolver-rules="MAP shop.example.test:443 127.0.0.1:<port>"` and certificate errors ignored, which opens the
storefront and its checkout at `https://shop.example.test/`. The seed enables no payment method and no shipping:
`sandbox.sh wp wc payment_gateway update cod --enabled=true --user=1`, the same for `bacs`, and
`sandbox.sh wp wc shipping_zone_method create 0 --method_id=flat_rate --user=1`.

Known differences from a real shop: the port in the address (the shop itself believes it is on 443, so its
`permalink`s and `Link` headers carry no port), and one machine's clock behind both the shop and the worker.

## How it is set up

- **The scripts refuse to run on any other site.** `php/setup.php`, `php/seed.php` and `php/key.php` (settings, data, API keys) stop with an error, and `mu-plugins/hanza-sandbox.php` (silences all mail) does nothing, unless the site's home URL is `https://shop.example.test`. They exist for this shop only; pointing `wp` at a real one must not change it.
- **The shop calls itself `https://shop.example.test`**, whatever port it listens on, so no link in a recorded
  response (`permalink`, `_links`, the `Link` header) names this machine. The price: the admin pages do not open
  in a browser. Use `wp` and `curl`.
- **API keys over plain HTTP.** WooCommerce accepts a consumer key as HTTP Basic only when WordPress thinks the
  request came over TLS. The official image's `wp-config.php` believes `X-Forwarded-Proto: https`, so the
  recording transport and `sandbox.sh curl` send that header; no other change is needed. The port is bound to
  127.0.0.1 only.
- **Site timezone `Europe/Warsaw`**, so a date filter that confuses site time with UTC is off by an hour or two.
- Currency PLN, prices entered with tax, one tax rate (PL, 23 %, also on shipping), stock management on.
- **HPOS on** (order tables), as on every shop created since WooCommerce 8.2. Installed through wp-cli,
  WooCommerce would keep orders in posts, so `up` turns it on.
- No WP-Cron and no updates (the shop must not change under a recording), no outgoing mail, and "hold stock" is
  empty, so WooCommerce never cancels a `pending` order on its own.
- `mu-plugins/hanza-sandbox.php` registers one order status of its own, `packing`, as shipping plugins do.
- Keys in the file: the read-write key (`consumerKey`, `consumerSecret`), `readOnly` (401 on a write) and
  `noCapability` (a subscriber's key: 403 everywhere), plus `sandboxUrl` and `storeUrl`, which the recording
  transport reads.

## The seed

`php/seed.php`. A fresh shop always gets the same ids, because the calls run in the same order: add new things
at the end of a section, never in the middle. Dates of creation and payment are fixed (21 September 2026, from
08:00 Warsaw time); `date_modified` is the moment of seeding.

| Id | Product |
| --- | --- |
| 10 | Simple, SKU `WOO-MUG-1`, 49.99, stock managed |
| 11 | Simple, `WOO-NOTE-1`, 19.90, stock managed |
| 12 | Simple, **no SKU**, stock managed |
| 13 | Simple, `WOO-CANDLE-1`, **stock management off** |
| 14 | Simple, `WOO-DRAFT-1`, **draft** |
| 15 | Simple, `WOO-NOPRICE-1`, **no price** |
| 16 | Simple, `WOO-BAG-1`, on sale (129.00 → 99.00) |
| 17 | Simple, `WOO-GIFT-100`, virtual |
| 19 | **Variable**, `WOO-TSHIRT`, manages stock. Variations: 20 (own SKU `WOO-TSHIRT-S`), 21 (**no SKU: reports the parent's**), 22 (`WOO-TSHIRT-L`, **`manage_stock: "parent"`**), 23 (`WOO-TSHIRT-XL`, **disabled**, stock 0) |
| 24 | **Variable** with two attributes, no SKU, no stock management. Variations: 25 (`WOO-HOODIE-BLK-M`), 26 (no SKU) |
| 27 | **Grouped** (10 and 11) |
| 28 | **External** |

Product 18 is deleted after order 43 was placed for it.

| Id | Order |
| --- | --- |
| 30 | `processing`, paid online |
| 31 | `processing`, `cod` |
| 32 | `on-hold`, `bacs`, two lines |
| 33 | `pending`, unpaid |
| 34 | `completed`, paid online |
| 35 | `cancelled`, never paid |
| 36 | `refunded` (37 is its refund, not an order) |
| 38 | `failed` |
| 39 | `processing`, paid: **four lines, two of them variations** (one with the parent's SKU), a product without a SKU, a coupon, a company, shipped to another person |
| 40 | `processing`, paid, virtual goods: **empty shipping address** |
| 41 | `processing`, paid, a Buyer in Germany: no tax, an address with a state |
| 42 | `on-hold`, `bacs`, with a customer note |
| 43 | `processing`, paid, **first line's product deleted** (`product_id` 0, `sku` null) |
| 44 | `on-hold`, **no lines** (does not fit the canonical Order) |
| 45 | `processing`, `cod`, **no address at all** (does not fit the canonical Order) |
| 46 | `checkout-draft` (never listed by `status=any`) |
| 47 | `packing` (the plugin's status), paid |
| 48 | `completed`, `cod` |
| 49 | `on-hold`, paid before |
| 50 to 57 | Eight more open orders. 52 and 53 are placed in the same second; 57 has the highest id and the earliest time. |

Twenty orders are open (`pending`, `on-hold`, `processing`): four pages at a page size of 5.
