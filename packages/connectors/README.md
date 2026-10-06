# Connectors

One directory per connector, each its own package (`@hanza/connector-<id>`).

A connector may depend only on `@hanza/connector-sdk` and `zod` —
`pnpm check:boundaries` enforces it. It has no UI, never touches the database,
and never imports the core or another connector. Layout and rules: see
`AGENTS.md` at the repo root and `.ai/skills/add-connector/SKILL.md`. A connector that needs an SDK or core change starts with a spec, which is a GitHub issue (see "Specs, decisions and vocabulary" in `AGENTS.md`).

Connectors speak **Order phases** (`new`, `processing`, `shipped`, `cancelled`), never an
organization's own Order statuses: they translate Channel statuses to and from phases in
code, and the core decides which Order status an Order gets (ADR 0018).

`orders.pull` returns Orders ready to fulfil. A connector may also return
Orders the Buyer has not paid for yet, with `awaitingPayment: true`, if it adds
a `paid` Channel fact once they are paid (ADR 0015; details in the skill):

- Synthesize the `paid` fact from the snapshot's payment status, with a stable
  id (for example `${orderId}:paid`) and `occurredAt` = the payment time.
  Dropping `awaitingPayment` without it leaves the Order awaiting payment.
- Once a `paid` fact exists, never set `awaitingPayment` back to true (chargeback,
  refund): one Order that breaks `orderSchema` turns the whole page into a
  `PermanentError` and stops the Connection's Order feed.

Every connector proves it follows the contract with the conformance kit
(`assertConformance` from `@hanza/connector-sdk/testing`), called from its own
`connector.test.ts` with recorded fixtures and no network.

A Channel must implement `offers.pull`, `orders.pull` and `stock.push`;
`price.push` and `orders.updateStatus` are optional. Hanza owns prices
(ADR 0011): `offers.pull` reports each Offer's current `price` so Hanza knows
the Channel's currency, and `price.push` sets the price Hanza sends, always in
that currency. Report that price as the canonical `Money`: a decimal string
with at most 4 decimal places and an upper-case ISO 4217 currency (`PLN`, not
`pln` or `zł`). Like any other field, a value that breaks the SDK schema fails
the whole `offers.pull` page, not just that Offer; if the Channel's price does
not fit, report `price: null`.

## Connectors

| Id | Package | Kind | What it is |
| --- | --- | --- | --- |
| `fake` | `@hanza/connector-fake` | marketplace | In-memory Channel for tests and demos, with every capability including `price.push`. The reference for how a connector looks. Not a real Channel. |

Allegro and WooCommerce come first among the real ones (stage 2 of the plan).
