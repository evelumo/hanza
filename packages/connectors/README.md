# Connectors

One directory per connector, each its own package (`@hanza/connector-<id>`).

A connector may depend only on `@hanza/connector-sdk` and `zod` —
`pnpm check:boundaries` enforces it. Layout and rules: see `AGENTS.md` at the
repo root and `.ai/skills/add-connector/SKILL.md`.

No connectors yet. Allegro and WooCommerce come first (stage 2 of the plan).
