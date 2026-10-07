# An Order feed starts with the Orders open now, restarts the same way, and takes Order updates for Orders Hanza has

Status: amends ADR 0003 (its last consequence)

Journal-style Channels (Allegro keeps 60 days of Order events, issue #87) left the `orders.pull` contract open in four places: where a new Connection starts, what happens when the saved cursor is older than the journal, how an address the Channel reveals only at payment reaches an imported Order, and how an Order the Channel deleted (a merged purchase) releases its Reservation. We decided that cursor `null` means "the Orders open on the Channel now, then the journal from a position taken before that listing", so Orders closed before the Connection never arrive; that a connector throws `CursorExpiredError` for a position the Channel no longer has, and the core resets the feed to `null` and appends `connection.order_feed_restarted`; and that `orders.pull` may return an Order update (`kind: 'update'`, facts and addresses), which the core applies only to an Order it already imported from that Connection, replacing addresses only while the Order is in phase new. Starting from history would consume Stock the seller counted on the shelf after those Orders shipped, and starting from the newest event would leave paid, unshipped Orders unreserved; both are Stock errors, not connector details.

## Considered options

- Starting at the oldest or the newest journal event: wrong Stock either way (above).
- A connector restarting silently on an expired cursor: nobody would learn that Orders placed and closed in the gap are missing.
- A new `ConnectorErrorKind` (and `sync_error_kind` value) for an expired cursor: a migration, a panel label and every exhaustive switch for a case only the Orders pull acts on. `CursorExpiredError` is a `PermanentError`, so anywhere else (another capability, cursor `null`, a second expiry in one run, an older core) it stops the run like any permanent failure.
- Reporting unpaid Orders only once paid (Allegro v1 before this): an oversell window while the Channel already took the unit off the Offer (ADR 0015).
- Updating an Order from every later snapshot: breaks ADR 0003's rule that only new Channel facts change an imported Order, and a Channel cannot snapshot an Order it deleted.

## Consequences

- An Order placed and closed while Hanza was stopped longer than the Channel keeps its journal is never imported. The restart Event shows that a gap may exist; saying it on the Connection page is issue #102.
- An Order update for an Order Hanza does not have is ignored (counted as `updatesIgnored` in the run's result), so a connector never needs to know what Hanza imported.
- The addresses of an Order are no longer only the first snapshot's: while the Order is in phase new, an update replaces them inside its sealed Buyer data (ADR 0016) and records `order.addresses_updated` without their content. Later, they are left as they are (the Order may be packed already; a Needs attention reason for it is issue #103). Erased Buyer data never comes back.
- `orderSchema` still requires a shipping address. A connector gives the best address the Channel has until it reveals the delivery address; an Order awaiting payment cannot be fulfilled (ADR 0015), so it is never shipped there. An optional address is a canonical-model change left for later (issue #101).
