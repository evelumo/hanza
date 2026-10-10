# Unset Stock is a Product without a Stock row, and only saving Stock creates one that stays

Status: accepted (issue #137). Keeps ADR 0001, ADR 0017 and ADR 0022; changes what `lockStock` leaves behind.

A Product created from an Offer got Stock 0, and Hanza pushed that 0 to every linked Offer, which ends an Offer on Allegro (issue #137). We decided, without a migration, that a Product with no Stock row in any Warehouse has unset Stock: its Offers are left out of stock pushes ("left out counts as applied") and the panel says so, while Available and placement count it as 0. Creating Products from Offers writes no Stock row. Only `setStock` (through `lockStockForWrite`) and creating a Product by hand keep a Stock row; a Reservation's `lockStock` still inserts the missing rows to lock them, then deletes the ones of a Product that had none before. Shipping such an Order takes nothing off Stock. Without this, the first Order of a new Product (the first sync imports the Orders open now, ADR 0021) would create its rows at 0 and push that 0 anyway.

## Considered options

- A nullable `setAt` on `Stock`, written by every operator change and import: needs a migration and a backfill decision for every existing row, and every row writer has to remember it. Rejected in the review of #137.
- `lockStock` creating no rows for a Product without Stock and locking nothing for it: a Reservation reading Available while Stock is saved for the first time could then cover its line without the lock, and two Reservations could use the same units.
- Creating rows with negative units when such an Order ships: the Product would have Stock, 0 would be pushed, and the Offer would end on the Channel exactly as before.

## Consequences

- Writers of a Product without Stock stay serialised: each one's insert of the same rows waits for the transaction that inserted (and deleted) them, as before. The deleted rows are gone once that transaction commits.
- A Product created by hand still gets its Stock row (the form asks for the initial Stock), so 0 entered there is pushed.
- Saving 0 over unset Stock is a change: it records `stock.set` with `from: null` and pushes 0.
- An Offer linked to a Product with unset Stock is Needs attention for the panel (Offers page, sidebar count, dashboard).
