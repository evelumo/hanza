# Core

How a tenant's Hanza connects to external systems and keeps a record of what happened.

## Language

**Connection**:
An organization's authorised account in one connector, for example one Allegro seller account. An organization can have several Connections to the same connector.
_Avoid_: Integration, account, link

**Channel**:
A Connection the organization sells through, i.e. a marketplace or a shop. Orders always come from a Channel; a courier or invoicing Connection is not a Channel.
_Avoid_: Sales channel, marketplace, store, source

**Status mapping**:
Per Channel, which Order status an Order gets when that Channel reports an Order phase: new on import, shipped or cancelled through a Channel fact. Without one, the phase's default status applies. It never changes what is sent to the Channel, which is always the phase.
_Avoid_: Status translation, status map, channel statuses

**Connection health**:
Whether Hanza can currently work with a Connection: not checked yet, working, failing, or waiting for the organization to sign in to the connector again. It waits for sign-in only when the Channel no longer accepts the credentials; a Channel refusing one request (a 403) makes it failing.
_Avoid_: Connection status, connection state

**Installation settings**:
A connector's settings that belong to the whole Hanza installation, not to one organization, such as the client id and secret of the OAuth application its operator registered with a marketplace. Set by whoever runs Hanza in `HANZA_CONNECTOR_<CONNECTOR>_<FIELD>`; a connector whose required ones are missing is "not set up" and cannot be connected.
_Avoid_: App config, global config, connector credentials

**Sign-in**:
A person proving to a Channel that Hanza may act for their account there, so a Connection gets its credentials: Hanza shows a code, the person approves it on the Channel's page, and Hanza stores the result. "Sign in again" does the same for an existing Connection and must end with the same Channel account.
_Avoid_: Authorization, OAuth flow, login, reconnect

**Channel account**:
The seller's account on the Channel that a Connection signed in as. One per Connection; an organization cannot connect the same Channel account twice.
_Avoid_: Seller id, profile, user

**Request budget**:
How many requests Hanza lets itself send to a connector's API in a window of time, or at once, set below the Channel's own rate limits: one budget shared by every Connection of that connector on the installation, across organizations, and one per Connection. The connector declares them, every worker shares them, and a job whose request does not fit waits or is delayed, never failed (ADR 0019).
_Avoid_: Quota, throttle

**Event**:
A record that something happened to an organization's data, written together with the change it describes. Events are a trail and a trigger, never the source of truth.
_Avoid_: Log entry, message, notification

**Workflow**:
A named, straight-line process of steps that may span days and several systems, for example "wait for the label, then ship the Order". A step runs code, sleeps until a time, or waits for a Signal.
_Avoid_: Automation (the user-facing rule built on top, later), pipeline, saga

**Workflow run**:
One execution of a Workflow for an organization, with its current step, the results of the steps done so far and its status (running, sleeping, waiting, completed, failed, cancelled). Identified by its id, or by the caller's key.
_Avoid_: Workflow instance, execution, job

**Signal**:
A named message with a payload sent to a Workflow run from outside, for example "label created"; a waiting run resumes when it arrives, and one sent early is kept until the run waits for it.
_Avoid_: Event (an Event is a record of a change), callback, webhook
### Buyer data

**Buyer data**:
Everything personal an Order holds about its Buyer: name, email, phone, Channel login, shipping and billing address. Stored sealed with the encryption key, read in plaintext only by the panel (ADR 0016).
_Avoid_: Customer data, PII, personal info

**Closed Order**:
An Order that reached the Order phase shipped or cancelled. Its `closedAt` is when that happened; nothing changes its phase afterwards, and moving it to another Order status of that phase (shipped → "Delivered") leaves `closedAt` alone.
_Avoid_: Completed, finished, terminal Order

**Erasure**:
Clearing the Buyer data of an Order while the Order itself, its lines, amounts, dates and shipping country stay. Only Closed Orders are erased, and an Erasure cannot be undone.
_Avoid_: Anonymisation, deletion, purge

**Retention period**:
How many days after an Order closed its Buyer data is kept before Hanza erases it. One value per organization, off by default; only owners and admins change it, after seeing how many Orders the next check would erase.
_Avoid_: TTL, expiry, data lifetime

**Erasure request**:
A person asking for their Buyer data to be erased now. Handled by an owner or admin; matched by exact email within the organization; matching Orders that are not closed yet are kept and reported.
_Avoid_: Deletion request, GDPR request, right to be forgotten
