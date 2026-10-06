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

**Workflow**:
A named, straight-line process of steps that may span days and several systems, for example "wait for the label, then ship the Order". A step runs code, sleeps until a time, or waits for a Signal.
_Avoid_: Automation (the user-facing rule built on top, later), pipeline, saga

**Workflow run**:
One execution of a Workflow for an organization, with its current step, the results of the steps done so far and its status (running, sleeping, waiting, completed, failed, cancelled). Identified by its id, or by the caller's key.
_Avoid_: Workflow instance, execution, job

**Signal**:
A named message with a payload sent to a Workflow run from outside, for example "label created"; a waiting run resumes when it arrives, and one sent early is kept until the run waits for it.
_Avoid_: Event (an Event is a record of a change), callback, webhook
