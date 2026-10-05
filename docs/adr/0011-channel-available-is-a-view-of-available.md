# Channel Available is a view of Available, not a separate stock pool

Status: amended by ADR 0013. The Available a Channel's number is based on, and that its Orders reserve against, is now that of the Warehouses the Channel counts, not the organization's.

Sellers want a safety margin per Channel and want to keep part of the Stock away from some Channels (issue #7). We decided that each Channel Connection has a Safety buffer and a Channel limit, and that these are used only to work out the number pushed to that Channel. Channel Available is `max(0, min(Available − Safety buffer, Channel limit))`, defined once in `getChannelAvailability`, so it is never below zero and never above Available. Reservations and Shortages still use the organization-wide Available, and the ADR 0004 locks are unchanged. A settings change takes its own locks: the Connection row (`FOR NO KEY UPDATE`), then the Connection's linked Offers in id order. It touches no Stock or Reservation row, so it never joins the ADR 0004 order. Separate stock pools per Channel were rejected: they would change how a Reservation is checked and which rows it locks, and that code decides whether goods that do not exist get sold.

## Considered options

- Separate stock pools per Channel (an Order may use only its Channel's share): rejected for the reason above.
- Percentage shares: they need rounding and "the shares add up to 100%" rules. Left for a follow-up issue.
- Settings in the connector's `config` JSON: rejected. That JSON belongs to the connector and is checked against its schema; these settings belong to Hanza.

## Consequences

- Units kept back from a Channel are not protected from it. If that Channel sells more than it was told (a stale push, a seller editing the listing by hand), the Order still reserves from the whole Available, and a line beyond it becomes a Shortage, as before.
- Changing a Connection's settings bumps the push sequence of its linked Offers in the same transaction (ADR 0010), so the new number reaches the Channel even if the enqueue after commit is lost.
- Settings are whole numbers from 0 (the service schema and database CHECK constraints enforce this). If an invalid value ever reaches `channelAvailable`, the Channel is told 0 rather than a guess (fail closed).
- Only a Channel has these settings. Any other Connection, or one whose connector this build does not know, is refused with `not_a_channel`.
- Code that needs "what does this Channel see" calls `getChannelAvailability`. Multiple Warehouses (#4) extend that function rather than the push job.
