# Connectors

One directory per connector, each its own package (`@hanza/connector-<id>`).

A connector may depend only on `@hanza/connector-sdk` and `zod` —
`pnpm check:boundaries` enforces it. It has no UI, never touches the database,
and never imports the core or another connector. Layout and rules: see
`AGENTS.md` at the repo root and `.ai/skills/add-connector/SKILL.md`. A connector that needs an SDK or core change starts with a spec, which is a GitHub issue (see "Specs, decisions and vocabulary" in `AGENTS.md`).

Every connector proves it follows the contract with the conformance kit
(`assertConformance` from `@hanza/connector-sdk/testing`), called from its own
`connector.test.ts` with recorded fixtures and no network.

A Channel must implement `offers.pull`, `orders.pull` and `stock.push`;
`price.push` and `orders.updateStatus` are optional. Hanza owns prices
(ADR 0011): `offers.pull` reports each Offer's current `price` so Hanza knows
the Channel's currency, and `price.push` sets the price Hanza sends, always in
that currency.

## Connectors

| Id | Package | Kind | What it is |
| --- | --- | --- | --- |
| `fake` | `@hanza/connector-fake` | marketplace | In-memory Channel for tests and demos, with every capability including `price.push`. The reference for how a connector looks. Not a real Channel. |

Allegro and WooCommerce come first among the real ones (stage 2 of the plan).
