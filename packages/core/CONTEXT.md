# Core

How a tenant's Hanza connects to external systems and keeps a record of what happened.

## Language

**Connection**:
An organization's authorised account in one connector, for example one Allegro seller account. An organization can have several Connections to the same connector.
_Avoid_: Integration, account, link

**Channel**:
A Connection the organization sells through, i.e. a marketplace or a shop. Orders always come from a Channel; a courier or invoicing Connection is not a Channel.
_Avoid_: Sales channel, marketplace, store, source

**Connection health**:
Whether Hanza can currently work with a Connection: not checked yet, working, failing, or waiting for the organization to sign in to the connector again.
_Avoid_: Connection status, connection state

**Event**:
A record that something happened to an organization's data, written together with the change it describes. Events are a trail and a trigger, never the source of truth.
_Avoid_: Log entry, message, notification

### Buyer data

**Buyer data**:
Everything personal an Order holds about its Buyer: name, email, phone, Channel login, shipping and billing address. Stored sealed with the encryption key, read in plaintext only by the panel (ADR 0011).
_Avoid_: Customer data, PII, personal info

**Closed Order**:
An Order that reached shipped or cancelled. Its `closedAt` is when that happened; nothing changes its status afterwards.
_Avoid_: Completed, finished, terminal Order

**Erasure**:
Clearing the Buyer data of an Order while the Order itself, its lines, amounts, dates and shipping country stay. Only Closed Orders are erased, and an Erasure cannot be undone.
_Avoid_: Anonymisation, deletion, purge

**Retention period**:
How many days after an Order closed its Buyer data is kept before Hanza erases it. One value per organization, off by default.
_Avoid_: TTL, expiry, data lifetime

**Erasure request**:
A person asking for their Buyer data to be erased now. Matched by exact email within the organization; matching Orders that are not closed yet are kept and reported.
_Avoid_: Deletion request, GDPR request, right to be forgotten
