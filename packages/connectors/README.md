# Connectors

One directory per connector, each its own package (`@hanza/connector-<id>`).

A connector may depend only on `@hanza/connector-sdk` and `zod` —
`pnpm check:boundaries` enforces it. It has no UI, never touches the database,
and never imports the core or another connector. Layout and rules: see
`AGENTS.md` at the repo root and `.ai/skills/add-connector/SKILL.md`. A connector that needs an SDK or core change starts with a spec, which is a GitHub issue (see "Specs, decisions and vocabulary" in `AGENTS.md`).

Connectors speak **Order phases** (`new`, `processing`, `shipped`, `cancelled`), never an
organization's own Order statuses: they translate Channel statuses to and from phases in
code, and the core decides which Order status an Order gets (ADR 0014).

Every connector proves it follows the contract with the conformance kit
(`assertConformance` from `@hanza/connector-sdk/testing`), called from its own
`connector.test.ts` with recorded fixtures and no network.

## Connectors

| Id | Package | Kind | What it is |
| --- | --- | --- | --- |
| `fake` | `@hanza/connector-fake` | marketplace | In-memory Channel for tests and demos. The reference for how a connector looks. Not a real Channel. |

Allegro and WooCommerce come first among the real ones (stage 2 of the plan).
