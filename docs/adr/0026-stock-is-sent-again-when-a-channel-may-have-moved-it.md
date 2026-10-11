# Hanza sends a Channel its number again whenever the Channel may have moved it

Status: accepted (issue #138). Builds on ADR 0001 and ADR 0010.

A Channel that keeps its own stock count changes it itself when an order moves: WooCommerce takes the units off when an order is paid and puts them back when it is cancelled. Hanza pushed an absolute number only when its own Available changed, so whatever the Channel did after Hanza's last push stayed: a cancellation made in Hanza left one unit too many in the shop, a payment one too few. We decided that Hanza marks an Order's Offers on that Order's own Connection for a stock push, and requests it, whenever that Channel may have moved their count: after a status push that reached the Channel, and when the Order feed reports a Channel fact Hanza had not recorded for an Order it has, also when the fact moved no Stock (`paid`; `cancelled` or `shipped` for an Order already closed). ADR 0001 says a Channel only receives Stock; that holds only if Hanza says the number again after the Channel changed it. The first number a Channel gets waits until its Order feed has caught up, as issue #125 implemented it (`caughtUpAt`); this decision only adds the numbers sent again after that.

## Considered options

- **Pushing the status before the stock in `changeOrderStatus`:** still two independent jobs; a delayed or failing status push puts them in the wrong order again.
- **A connector flag (`adjustsOwnStock`):** saves a few pushes on Channels that never adjust, for an SDK change and a default whose wrong value is an oversell. It could be added later to switch the reassertion off, never on.
- **Marking the Product's Offers on every Channel:** the other Channels were told nothing and reported nothing, so their count did not move. When the fact does change Available, they are marked as before.
- **Marking on every Order the feed returns:** a shop stamps an order as modified when Hanza pushes a status, so every pull would push. Only a fact not recorded yet marks.
- **A periodic reassertion of every Offer** (a seller editing stock in the shop, an order the connector skipped): a cost question per Channel, left open in #138.

## Consequences

- An Order event costs one extra stock push of that Order's Offers on its Channel. A retried status push may mark twice; a mark only makes the next push send the number, which is absolute.
- The Offers marked are those linked to the Products of the Order's lines and those its lines name, on that Connection. Marks and Reservations go in one statement per transaction, so Offers are still locked once, in id order (ADR 0017, step 4).
- The core knows a status reached the Channel by the request the connector made through `ctx.fetch`. A status the connector resolves without a request marks nothing.
- A status the Channel took while its answer was lost is marked only when the retry succeeds; until then the Channel's count can be off by that Order's units.
- The reassertion follows the Channel's change only if the Channel made it before it answered. A Channel that adjusts its count later is corrected by the next Order event or change of Available, not at once.
- A mark goes through the stock push like any other: it waits while the Connection's Order feed has not caught up (#125), and an Offer whose Product has unset Stock is still left out (ADR 0023).
- A lost enqueue is recovered as in ADR 0010: the marked Offers stay ahead of their pushed sequence, and the tick starts the stock push every 10 minutes.
