# Hanza sends a Channel its number again whenever the Channel may have moved it, and no number before it has read that Channel's Orders

Status: accepted (issue #138). Builds on ADR 0001 and ADR 0010.

A Channel that keeps its own stock count changes it itself when an order moves: WooCommerce takes the units off when an order is paid and puts them back when it is cancelled. Hanza pushed an absolute number only when its own Available changed, so whatever the Channel did after Hanza's last push stayed: a cancellation made in Hanza left one unit too many in the shop, a payment one too few, and a new Connection was told Stock before Hanza knew the Orders open there. We decided that Hanza marks an Order's Offers on that Order's own Connection for a stock push, and requests it, whenever that Channel may have moved their count: after a status push that reached the Channel, and when the Order feed reports a Channel fact Hanza had not recorded for an Order it has, also when the fact moved no Stock (`paid`; `cancelled` or `shipped` for an Order already closed). And that a Channel is told no Stock at all until its Order feed has been read to its end, or it has been told Stock before. ADR 0001 says a Channel only receives Stock; that holds only if Hanza says the number again after the Channel changed it.

## How the core knows the Order feed has been read

No new column. `mayPushStock` reads the two sync states the runs record anyway:

- the last successful Orders pull reached the end of the feed. A run that stops at its page limit with more to read writes `more` into its result, and the next run carries on; or
- a stock push reached the Channel before.

The stock push job asks this itself, so it holds whoever requested the push (a linked Offer, a Stock edit, a Retry, the tick). The Orders pull that first reads the feed to its end requests the push.

## Considered options

- **Pushing the status before the stock in `changeOrderStatus`:** still two independent jobs; a delayed or failing status push puts them in the wrong order again.
- **A connector flag (`adjustsOwnStock`):** saves a few pushes on Channels that never adjust, for an SDK change and a default whose wrong value is an oversell. It could be added later to switch the reassertion off, never on.
- **Marking the Product's Offers on every Channel:** the other Channels were told nothing and reported nothing, so their count did not move. When the fact does change Available, they are marked as before.
- **Marking on every Order the feed returns:** a shop stamps an order as modified when Hanza pushes a status, so every pull would push. Only a fact not recorded yet marks.
- **A column for "the feed was read once":** a migration and a backfill for a question the sync states already answer. The backfill would also open the gate for a Connection that has never pulled an Order nor pushed a number.
- **Holding the push whenever the feed is behind, also for a Channel already told Stock:** its number also carries what other Channels sold, so withholding it oversells there. Only the first number waits.
- **A periodic reassertion of every Offer** (a seller editing stock in the shop, an order the connector skipped): a cost question per Channel, left open in #138.

## Consequences

- An Order event costs one extra stock push of that Order's Offers on its Channel. A retried status push may mark twice; a mark only makes the next push send the number, which is absolute.
- The Offers marked are those linked to the Products of the Order's lines and those its lines name, on that Connection. Marks and Reservations go in one statement per transaction, so Offers are still locked once, in id order (ADR 0017, step 4).
- The core knows a status reached the Channel by the request the connector made through `ctx.fetch`. A status the connector resolves without a request marks nothing.
- A status the Channel took while its answer was lost is marked only when the retry succeeds; until then the Channel's count can be off by that Order's units.
- The reassertion follows the Channel's change only if the Channel made it before it answered. A Channel that adjusts its count later is corrected by the next Order event or change of Available, not at once.
- A new Channel whose Orders pull keeps failing is told no Stock, and keeps the numbers it had: the Connection shows failing (or waiting for sign-in) with the Orders pull's error, and its Offers show their stock as waiting to be sent. Saying so on the Connection page is a follow-up.
- A Channel that was told Stock keeps getting it while its feed restarts (ADR 0021) or falls behind by more than one run. A Channel never told a number waits again while its last Orders pull left more to read.
- A Connection from before this change keeps pushing: its Orders pull has succeeded without the `more` marker, or it has pushed Stock.
- A lost enqueue is recovered as in ADR 0010: the marked Offers stay ahead of their pushed sequence, and the tick starts the stock push every 10 minutes.
