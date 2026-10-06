# Connectors receive decrypted credentials and authenticate their own requests

Channels authenticate in incompatible ways (static keys, OAuth tokens that refresh, signed requests), so a fetch wrapper in the core that adds authentication would either grow into a second connector layer or fail on the first unusual Channel. We decided a connector declares a `credentialsSchema`, the core stores the credentials sealed and hands them, decrypted and parsed, to every capability together with a plain `fetch` (only a 30 s timeout added); the connector adds its own authentication. Credentials are sealed with AES-256-GCM using `HANZA_ENCRYPTION_KEY`, with the organization id as authenticated data, so a sealed value copied to another organization's Connection does not open. They are decrypted only in the worker, never selected by panel queries, never put in Events or logs.

## Consequences

- Connector code sees secrets, so it must never log them or put them in an error message; that is a rule for connector authors and reviewers, not something the core can enforce.
- Losing the key means signing in to every connector again. Key rotation is not built; the `v1:` prefix of the sealed format leaves room for it.
- Amended by ADR 0020: connectors still authenticate their own requests, but the core decides when OAuth tokens are refreshed, serialises the refreshes and stores the rotated credentials.
