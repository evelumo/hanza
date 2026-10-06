# The core owns token lifetime; connectors only know how to refresh

Amends ADR 0006.

OAuth Channels such as Allegro issue access tokens that live for hours and rotate the refresh token on every refresh, so the old one stops working within seconds. A Connection's runs (Offers, Orders, stock, prices, one status push per Order) execute in parallel across worker processes, and a connector cannot persist anything, so a connector that refreshed on its own would lose the rotated token, or two runs would each spend the same refresh token and one would kill the Connection.

We decided that a connector with `auth.type: 'oauth2'` still adds the token to its requests and knows how to talk to its token endpoint (`auth.refresh`, `auth.expiresAt`, and `auth.deviceFlow` for signing in), but the core decides when to refresh: before a run when the access token expires within 15 minutes, and once after a capability call fails with `auth_expired`, retrying that call once. A refresh runs in one transaction holding a Postgres advisory lock per Connection: it re-reads the credentials, does nothing but return them if their `credentialsVersion` moved since the caller read it (another job already refreshed), otherwise calls `auth.refresh`, then seals the result and writes it with the version bumped as a compare-and-swap. The token request therefore happens inside the transaction, so a rotated pair is stored before anything uses it, or never used. A refused refresh sets health `auth_expired`, without retries; only a sign-in (the device flow, which writes credentials under the same lock) or a successful run clears it.

## Considered options

- **Refresh inside the connector:** cannot store the rotated token, and cannot coordinate parallel runs.
- **A row lock on `connection`:** `setHealth` locks that row (`FOR NO KEY UPDATE`), so every run of the Connection would wait on a token request for up to 30 s. The advisory lock only serialises credential writes.
- **A Redis lock:** a lock lost to its TTL lets two refreshes through, and the write goes to Postgres anyway.

## Consequences

- A transaction stays open across one HTTP request (bounded by the 30 s fetch timeout; the transaction allows 45 s), holding one database connection per refreshing Connection.
- A Connection whose refresh token died costs one token request per job already queued for it, then nothing: the tick skips `auth_expired` Connections (ADR 0008).
- Connectors still see secrets and must never log them (ADR 0006); the core logs ids only and writes no Event per refresh.
