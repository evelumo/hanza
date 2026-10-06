# Connectors declare rate limits; the core enforces them in Redis around `ctx.fetch`

Status: accepted (issues #86, #82)

A Channel's limits are per API application (Allegro: 9,000 requests a minute per Client ID, a breach blocks the Client ID for a minute) and per account, while one Hanza installation runs that application for every organization's Connections on several workers at once; handling only the 429 after the fact lets one busy organization block all the others. We decided that a connector declares its budgets in `defineConnector({ rateLimits })` (requests per window for the application and per Connection, and per-Connection concurrency), and the core enforces them in the `fetch` it hands the connector, with Lua scripts on the Redis the queue already uses, keyed `<prefix>:ratelimit:app:<connectorId>` and `<prefix>:ratelimit:conn:<connectionId>`. The Channel's limits are facts about its API, which the connector knows; counting across processes is infrastructure, which only the core has, and a connector must never hold state of its own.

## Considered options

- **Limits inside each connector**: per process only, so N workers send N times the budget.
- **BullMQ's limiter**: limits a whole queue, not a key, and counts jobs, not requests.
- **GCRA / token bucket**: one value per key, but a burst of the full budget followed by the steady rate lets about twice the budget through in a sliding window. We use an exact sliding-window log (a sorted set of request times, O(budget) memory per key: a few hundred KB for 6,000 a minute) that never lets more than the budget into any window.

## Consequences

- A request whose slot is at most 2 s away waits for it (a reservation, no polling); otherwise `ctx.fetch` rejects with `RateLimitedError` before sending, and the job is delayed without using an attempt. Connectors must let a `ConnectorError` from `ctx.fetch` through unchanged.
- A 429 parks every budget of that request (the Connection's and the application's) for the Channel's Retry-After, 60 s when it gives none, because it cannot tell which limit it hit; per-endpoint budgets and telling them apart are #91.
- Times come from Redis's clock, so workers with skewed clocks agree. The scripts assume one Redis, not a cluster.
- Redis down means no limits (fail open, logged): the queue is down then too.
- The application budget is the only state shared across organizations; it holds request times, never data.
- ADR 0006's "plain fetch" now also enforces these limits; it still adds no authentication.
