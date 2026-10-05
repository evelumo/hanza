# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This repo is **multi-context**: each workspace package (`apps/*`, `packages/*`, `packages/connectors/*`) can own its own context.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root: it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`**: system-wide decisions. Read ADRs that touch the area you're about to work in.
- **`<package>/docs/adr/`** (e.g. `packages/core/docs/adr/`): context-scoped decisions for the package you're working in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← system-wide decisions
├── apps/
│   ├── web/
│   │   ├── CONTEXT.md
│   │   └── docs/adr/                  ← context-specific decisions
│   └── worker/
│       └── CONTEXT.md
└── packages/
    ├── core/
    │   ├── CONTEXT.md
    │   └── docs/adr/
    ├── db/
    │   └── CONTEXT.md
    ├── connector-sdk/
    │   └── CONTEXT.md                 ← canonical model vocabulary (Order, StockLevel, …)
    └── connectors/<id>/
        └── CONTEXT.md
```

Not every package needs a `CONTEXT.md`; a context exists only once it has vocabulary of its own. `CONTEXT-MAP.md` is the source of truth for which contexts exist.

## Relationship to specs

ADRs record decisions that outlive the work that produced them. Specs are GitHub issues (see `AGENTS.md`, "Specs, decisions and vocabulary", and `issue-tracker.md`): they describe a change before it is built and are closed once it ships, after which the code and the ADRs are the source of truth. A non-trivial change starts with a spec; only a decision that is hard to reverse, surprising without context and a real trade-off becomes an ADR.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the relevant `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
