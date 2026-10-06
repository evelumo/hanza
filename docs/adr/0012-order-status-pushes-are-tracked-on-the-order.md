# A pending Order status push is tracked on the Order and swept by `sync.tick`

Status: amends ADR 0010 (its first consequence)

ADR 0010 made the enqueue after a status change best-effort, so a status push lost with the queue was never re-sent (issue #13). We decided the status change marks the push pending on the Order in the same transaction: `statusPushSeq` counts the changes a person makes, and `statusPushDueAt` is set (10 minutes ahead, database clock) while the Channel has not been told the current status, if the Order's connector can update statuses at all. The immediate enqueue stays as the fast path; every tick, each Channel's overdue pushes are claimed by moving their due time 10 minutes ahead, then enqueued with the per-Order coalesce key (one per tick while the Connection is failing, so a Channel that is down is probed, not flooded). A push sends the current status only while the mark is set and clears it only for the `statusPushSeq` it read, so duplicate requests send nothing and a status changed mid-push is sent after it; seq 0 means a job enqueued before this change, which is still pushed. A Channel fact that moves the status drops the mark (ADR 0003: it is never pushed back). A permanent refusal drops the mark for that status and marks the Order Needs attention (`status_push_failed`), so the sweep never re-sends a status the Channel will not take; a later status the Channel takes clears that reason.

## Considered options

- An outbox table of push requests: tenant scoping, deduplication per Order and cleanup for nothing, as only the latest status is ever pushed.
- Two counters like the Offer's stock push: a column-to-column test cannot use a plain index and leaves no room for a retry time, so a Channel that is down would be called every tick.
- Sweeping when the `order_status_push` stream is due: any push on the Connection would postpone the sweep for every other Order.

## Consequences

- The Channel learns a lost status within about 11 minutes (longer while the Connection is failing), and a status that keeps failing for a transient reason is retried every 10 minutes, not every tick.
- Intermediate statuses can be skipped: two changes before the push send only the second.
- "Always told eventually" is about Hanza's final status, not about order of arrival against the Channel's own changes: a push already in flight when the Channel's cancel fact is imported can still reach the Channel after that fact (a race that predates this ADR).
- A refused status is not re-sent automatically; a person sees the Order in Needs attention (a "re-send" action is issue #23).
