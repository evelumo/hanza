# Order status is a fixed list owned by Hanza, and Channel facts never reopen a final one

Each Channel has its own statuses, and stock depends on where an Order is: a Reservation is released on cancel and consumed on ship. We decided Hanza keeps its own Order status (`new`, `processing`, `shipped`, `cancelled`; the last two are final), the same for every organization. A connector translates in both directions: inbound, it reports Channel facts (`cancelled`, `shipped`) instead of a status; outbound, `orders.updateStatus` maps Hanza's status to the Channel's. A fact is always recorded, but it never moves an Order out of a final status: it marks the Order Needs attention instead, because reopening a shipped Order would mean putting Stock back on a shelf nobody checked. A change that came from a fact is never pushed back to the Channel.

## Consequences

- Organization-defined statuses and per-Channel mapping are a later, larger change (issue #1).
- A Channel that disagrees with Hanza about a final Order needs a person, not an automatic fix.
- An imported Order is a snapshot: only new Channel facts change it afterwards.
