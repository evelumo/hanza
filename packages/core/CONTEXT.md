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
