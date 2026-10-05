# Commerce model

The canonical vocabulary of Hanza. Every connector translates an external system's data into these terms and back, so the rest of the system never speaks Allegro or WooCommerce.

## Language

**Product**:
One sellable item, identified by its SKU within an organization. A T-shirt in three sizes is three Products.
_Avoid_: Variant, item, article

**Offer**:
The presence of one Product on one Channel — the thing a Buyer actually sees and buys there. Linked to its Product by SKU, or by hand when the SKU does not match.
_Avoid_: Listing, auction, external product

### Stock

**Stock**:
How many units of a Product physically sit in a Warehouse. Hanza is the only source of truth for Stock; every Channel only receives it.
_Avoid_: Inventory, quantity, on-hand

**Warehouse**:
A place where Stock is kept. Every organization has at least one.
_Avoid_: Location, storage, inventory

**Reservation**:
Units of Stock promised to an Order that has not shipped yet. Made when the Order arrives, released when it is cancelled, consumed when it ships.
_Avoid_: Allocation, hold, booking

**Available**:
Stock minus Reservations — the number Hanza tells Channels. It can go below zero when the same last unit sells on two Channels at once.
_Avoid_: Free stock, sellable quantity

**Shortage**:
An Order line whose Reservation could not be covered by Stock. A person decides what happens next; Hanza never cancels the Order on its own.
_Avoid_: Oversell, backorder

### Orders

**Order**:
A Buyer's purchase placed on one Channel. After it reaches Hanza, its progress through fulfilment is owned by Hanza and is not a mirror of the Channel's status.
_Avoid_: Purchase, transaction, checkout form

**Order phase**:
Where an Order is in fulfilment as far as Stock and Channels are concerned: new, processing, shipped or cancelled (the last two are final). One fixed list shared by every organization; Reservations, Channel facts, Needs attention and the status sent to a Channel all depend on it, and each connector translates between it and its Channel's own statuses, in both directions (ADR 0003, ADR 0014). The SDK still names it `OrderStatus`.
_Avoid_: Base status, system status, stage, state

**Order status**:
An organization's own label for where an Order is, such as "Waiting for packaging". Each one belongs to exactly one Order phase, and every phase has a default status; moving between two statuses of the same phase changes nothing but the label and is never sent to a Channel (ADR 0014).
_Avoid_: State, stage, step, phase

**Channel fact**:
Something the Channel reports about an Order after it was placed, such as "cancelled by buyer". Always recorded as reported. It moves the Order phase accordingly (to the status the Status mapping names, else the phase default), except that an Order that is already shipped or cancelled stays as it is and is marked Needs attention instead (ADR 0003).
_Avoid_: External status, remote status

**Needs attention**:
A mark on an Order that a person must look at, for example when the Buyer cancels while it is already being packed, when an Order line could not be matched to a Product, or when the Channel refused the status Hanza sent it.
_Avoid_: Flag, alert, warning

**Unmatched line**:
An Order line that could not be linked to any Product. The Order is still imported; the line reserves nothing until someone links it.
_Avoid_: Unknown product, orphan line

**Buyer**:
The person who placed an Order, kept as a snapshot on that Order together with their addresses. Buyers are not linked across Orders or Channels.
_Avoid_: Customer, client, user
