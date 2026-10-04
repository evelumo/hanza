# Specs

Hanza is spec-first: a non-trivial change is designed in a short written spec, reviewed, and only then implemented. Specs are the shared memory for humans and AI agents; they say why the code looks the way it does.

## When a spec is required

Write one before changing:

- the database schema (new model, changed relations, tenant scoping);
- the canonical model or the Connector SDK contract (`packages/connector-sdk`);
- auth, tenancy or permissions;
- stock, reservation or sync semantics (cursors, retries, idempotency);
- the job/queue contract or the shape of `createContext()`;
- anything that needs a new production dependency;
- a new module, connector capability, or public API.

Not required: bug fixes, refactors without contract changes, copy changes, adding a connector that fits the current SDK unchanged.

## Workflow

1. Copy `TEMPLATE.md` to `YYYY-MM-DD-title.md` (date of creation, lowercase kebab-case title, e.g. `2026-10-12-canonical-order-model.md`).
2. Fill in every section; write "None" instead of deleting a section. Keep it short; link to code by path.
3. Get it reviewed (pull request or discussion). Resolve Open questions before implementing; unresolved ones block the affected part only.
4. Implement against the spec. If reality diverges, update the spec in the same change and add a Changelog line.
5. Set `Status` to `implemented` when it ships. Do not delete old specs; mark them `superseded by <file>`.

## Status values

`draft` → `accepted` → `implemented` (or `rejected` / `superseded`).

## For AI agents

- If a task needs a change from the list above and no spec exists, write the spec first and stop for review; do not start on the code.
- If you are in the middle of a task (for example adding a connector) and find you need to change the SDK or core, stop and write a spec instead.
- Read the specs relevant to the area you touch before editing it.
