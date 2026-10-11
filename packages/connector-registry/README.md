# @hanza/connector-registry

The build-time list of connectors available to Hanza's apps. This is the only workspace package with connector implementations in production `dependencies`.

`src/index.ts` exports the connector definitions. Web and worker pass them into `createContext()`; the core does not import this package. This keeps concrete APIs outside the core's dependency graph ([ADR 0007](../../docs/adr/0007-connector-registry-is-a-separate-package.md)).

## Current registry

- `fake`: the in-memory Test channel.
- `fake-oauth`: the simulated Test OAuth channel, usable when required installation settings are supplied.
- `woocommerce`: a WooCommerce shop (orders in, stock out; an API key per Connection, no installation settings). Allegro is planned.

The `fake-http` and `fake-http-oauth` implementations are test references, not registered panel connectors. `woocommerce` is the first real connector.

## Add a connector

Follow [the connector guide](../connectors/README.md) and [add-connector skill](../../.ai/skills/add-connector/SKILL.md). Add the connector package as a dependency here and its definition to the exported list. Run `pnpm check:boundaries`, `pnpm typecheck` and `pnpm test` from the root.

Auto-discovery, a generated registry and community connector distribution are planned. Today the list is maintained explicitly.
