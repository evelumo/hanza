# Stock pushes always send the real number, and reopen only Offers that sold out

Status: accepted (issues #88, #68, Decision 3 of #82)

On Allegro, and on other marketplaces, a quantity of 0 ends an Offer, and raising the quantity later does not bring it back; the seller can also end an Offer by hand, and it can expire. We decided that Hanza always pushes the real number, 0 included, and that the Channel's answer is recorded as the Offer's publication (ended, sold out). To an Offer the Channel reports ended, Hanza sends a number above 0 only when the Channel ended it because it sold out and the connector declares `reopensSoldOutOffers` (its `stock.push` reactivates such an Offer); any other ended Offer gets a push rejection (`offer_ended`) without a call, and a 0 to an ended Offer is not sent. Skipping 0 would advertise stock that does not exist (ADR 0001), and reopening an Offer someone ended on purpose would put back on sale what the seller took off it.

## Considered options

- Never push 0, keep the Offer at 1 or leave it: rejected. It sells goods that do not exist.
- Reopen every ended Offer when stock comes back: rejected. It overrides a seller's or an admin's decision, and may cost a listing fee.
- A per-Connection setting "reopen sold-out Offers", off by default: deferred. Needed only if a Channel cannot tell a sold-out Offer from one the seller ended (to be checked in the Allegro sandbox: whether a 0 set by the application is recorded as `EMPTY_STOCK` or `USER`).

## Consequences

- A connector reports the publication in `offers.pull` (`status`, `endedReason`) and `ended` in its `stock.push` results; one that reports nothing is pushed exactly as before.
- An Offer reactivated in the Channel's own panel is pushed again after the next `offers.pull` reports it active (a reported publication change marks the Offer for a push).
- Inactive (draft) Offers are pushed like active ones; skipping them is left for later (#106).
- Hanza decides from the publication it last recorded, which can be out of date. An Offer recorded as ended holds back a 0 until the next `offers.pull` (hourly) reports it otherwise; a number above 0 is still sent to a sold-out one. And because Hanza cannot see why an Offer ended at push time, a connector that declares `reopensSoldOutOffers` must check it itself and report any other ended Offer as rejected.
- A refused push no longer turns the Connection `failing` (#68): a Channel refusing an Offer's number, a 0 included, now shows only on that Offer, the Product's Offers and the Connection page's list of rejected Offers. Accepted, because one refused Offer must not stop every other Offer's stock; making these rejections more visible is #107.
