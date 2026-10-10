# A carrier pickup ships the Order

Status: accepted (issue #126; decided with the repo owner, since it changes when Reservations are consumed)

Until now an Order became shipped when a person said so or the Channel reported it (ADR 0003), so a seller who handed the parcel over still had to come back and press "Mark as shipped", and until then its units stayed reserved instead of leaving Stock. We decided that the first time a Shipment is seen in a status that means the Carrier has the parcel (`in_transit`, `awaiting_pickup`, `delivery_problem`, `delivered`, `returned`; never `ready`, a printed Label is not a parcel), the core sets `handedOverAt` and, in the same transaction, moves the Order to phase shipped through the very code a person's change runs (`moveOrderToStatus`): Reservations consumed, `closedAt` set, the push to the Channel marked pending, `order.status_changed` recorded with the system as actor and the Shipment's id. The Carrier's scan is the most reliable sign the goods left the shelf, and one implementation means the Stock rules cannot drift between the two paths.

## Decisions within it

- **Locks.** The Shipment's status is written under its Order's lock, taken first, so the transaction continues in the fixed order of ADR 0004 and ADR 0017: Order row, then the Shipment row, then the Warehouse rows, the Stock rows, the Offers. Nothing locks a Shipment row and then an Order. A person shipping the Order at the same moment waits for the same lock; whoever comes second finds it shipped.
- **Only an open Order moves.** One in phase new or processing ships. One already shipped is left exactly as it is, whatever its status within that phase, so nothing is consumed twice and a second Shipment of the same Order changes nothing. The first parcel ships the whole Order; there is no partial shipment.
- **An Order that cannot ship is not forced.** A cancelled Order, one awaiting payment, or one with an Unmatched line is left alone and marked Needs attention with `shipment_conflict`, raised once however many of its parcels go; a person settles it and clears it with `resolveAttention`. Cancelling an Order keeps the reason, because the parcel is with the Carrier all the same.
- **The status.** The Order gets the default status of phase shipped, as when a person chooses the phase. A Status mapping is not consulted: it says what a Channel's report means (ADR 0018), and this is not one.
- **A return changes nothing.** A Shipment that comes back leaves the Order shipped; putting units back on the shelf is a person's count.

## Considered options

- A `shipped` Channel fact synthesised from the pickup: a fact is the Channel's word, is never pushed back (ADR 0003), and here the Channel must be told.
- Shipping an Order awaiting payment anyway, as a `shipped` Channel fact does (ADR 0015): a Channel that reports an Order shipped knows about its payment; a Carrier does not.
- Waiting for `delivered`: Stock would be wrong for days while the parcel is plainly gone.
- A workflow that waits for the pickup and then ships: a second path to phase shipped with its own failure modes, for one transaction's worth of work.

## Consequences

- Stock can now leave the shelf without a person: a Shipment made for the wrong Order ships that Order when the Carrier takes the parcel. The Event names the Shipment, and a final phase is never left (ADR 0003).
- The time an Order ships is when Hanza hears of the pickup, not when the Carrier scanned the parcel: up to a check interval later, which is 15 minutes for a confirmed Shipment (ADR 0023).
- A Shipment of an Order that a person or the Channel already cancelled is not cancelled for them; if the Carrier takes it, the Order needs attention.
- `shipment_conflict` on an Order awaiting payment or with an Unmatched line does not clear itself when the cause is fixed: the person ships the Order by hand and marks it reviewed.
- Delivery problems and returns as Needs attention, and partial shipment, are follow-ups.
