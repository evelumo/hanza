# Unset Stock is a Product nobody counted yet, recorded on the Product

Status: accepted (issue #137). Keeps ADR 0001, ADR 0017 and ADR 0022.

A Product created from an Offer got Stock 0, and Hanza pushed that 0 to every linked Offer, which ends a live Offer on Allegro: one click on "Create products" took a seller's whole catalogue off the marketplace (issue #137). We decided that `Product.stockSetAt` records when someone first saved the Product's Stock, in any Warehouse and of any number, 0 included. While it is null the Product has unset Stock: the stock push leaves its Offers out ("left out counts as applied"), the panel shows them as "Stock not set" and counts them as needing attention, and Available, placement and shipping treat its Stock as 0, as for any Product. `setStock` and creating a Product by hand set it; creating Products from Offers does not. Stock locking and Reservations are unchanged. Unset Stock is a fact about the Product (nobody has counted it), so it lives on the Product, and a push rule does not reach into reservation locking.

## Considered options

- Unset Stock as the absence of Stock rows, with `lockStock` deleting the rows it inserts to lock for such a Product (the first version of #163): rejected. It changes reservation locking (ADR 0017) for a push rule, and it encodes a state as missing data, which every writer of Stock rows would have to respect.
- A `setAt` per `Stock` row: rejected. The fact is per Product: once its Stock is saved in one Warehouse, the empty ones are a real 0.
- Seeding Stock from the Channel's number, or a per-Connection "do not push yet" switch: dropped in the spec (the Channel's number is after its own reservations, and several Channels disagree).

## Consequences

- The migration sets `stockSetAt` to `createdAt` for every existing Product: each was created with an explicit Stock, so it keeps being pushed as before.
- A Reservation may still create Stock rows at 0, and shipping still takes units off Stock; neither sets the Stock, so nothing is pushed for such a Product until someone saves its Stock.
- Saving 0 over unset Stock is a change: it records `stock.set` with `from: null` and pushes 0.
- Linking an Offer to a Product with unset Stock marks it as before but requests no push; the push leaves it out.
