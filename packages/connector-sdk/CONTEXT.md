# Commerce model

The canonical vocabulary of Hanza. Every connector translates an external system's data into these terms and back, so the rest of the system never speaks Allegro or WooCommerce.

## Language

**Product**:
One sellable item, identified by its SKU within an organization. A T-shirt in three sizes is three Products, which can be grouped in a Product family.
_Avoid_: Variant, item, article

**Product family**:
A named group of Products that are sizes, colours or other variations of one another (a T-shirt in three sizes is one family of three Products). A Product is in at most one family. A family only groups: Orders, Stock, Reservations and Offers keep pointing at the individual Products. Deleting a family ungroups its Products and never deletes them.
_Avoid_: Variant group, product group, parent product, master product

**Family attribute**:
What tells the Products of one family apart, such as Size or Colour. A family lists its attributes (fixed once the family exists), and each Product in it has one value per attribute; no two Products of a family have the same values.
_Avoid_: Variant attribute, option, property

**Offer**:
The presence of one Product on one Channel — the thing a Buyer actually sees and buys there. Linked to its Product by SKU, or by hand when the SKU does not match.
_Avoid_: Listing, auction, external product

**Offer publication**:
Whether an Offer is for sale on its Channel, as the Channel reports it: active, inactive (a draft never published) or ended; unknown while the Channel has not said. An ended Offer stays linked. Not to be confused with an Order status.
_Avoid_: Offer status, listing state

**Sold out (Offer)**:
An ended Offer the Channel ended because its stock reached 0, for example after Hanza pushed 0. The only kind of ended Offer Hanza reopens, by pushing a number above 0, and only through a connector that can (ADR 0022); one ended by the seller, an admin or expiry is never reopened.
_Avoid_: Out of stock, empty

### Stock

**Stock**:
How many units of a Product physically sit in a Warehouse. Hanza is the only source of truth for Stock; every Channel only receives it.
_Avoid_: Inventory, quantity, on-hand

**Warehouse**:
A place where Stock is kept. Every organization has at least one, the default Warehouse, which gets a new Product's initial Stock and is always active. An inactive Warehouse holds nothing and counts for no Channel. Warehouses have a priority: lower is used first when a Reservation is placed.
_Avoid_: Location, storage, inventory

**Channel Warehouses**:
The Warehouses a Channel counts: every active one (the default, including ones added later), or the ones chosen for it. The Channel is told only their Available, and its Orders reserve only in them (ADR 0017).
_Avoid_: Fulfilment set, warehouse scope, sources

**Reservation**:
Units of Stock promised to an Order that has not shipped yet, always in exactly one Warehouse. Made when the Order arrives (also when it is Awaiting payment), in the first of its Channel Warehouses (by priority) whose Available covers the whole line; released when the Order is cancelled, consumed when it ships, both in that Warehouse. A person can move it to another Warehouse that covers it.
_Avoid_: Allocation, hold, booking

**Available**:
Stock minus open Reservations, per Warehouse (for a Product's total, the sum over all Warehouses). Each Channel is told its Channel Available, which is worked out from the Available of its Channel Warehouses. It can go below zero when the same last unit sells on two Channels at once.
_Avoid_: Free stock, sellable quantity

**Channel Available**:
The number Hanza tells one Channel for a Product: what one of its Channel Warehouses can cover (the largest single Available among them, and never more than their total), minus its Safety buffer, at most its Channel limit. Never below zero. A line is never split, so any line up to this number fits in one Warehouse. Orders reserve against Available, not against this number (ADR 0013, ADR 0017). It is sent when it changes, and again whenever the Channel may have moved its own count of an Order's Offers: after Hanza told it that Order's status, and when it reports a Channel fact Hanza had not recorded. A Channel is told nothing before Hanza has read the Orders open there (ADR 0023).
_Avoid_: Channel stock, advertised stock, allocation

**Safety buffer**:
A number of units of Available that one Channel is never told about. It makes it less likely that the last units sell twice, or keeps them for other Channels.
_Avoid_: Reserve, margin, allocation

**Channel limit**:
The most units Hanza tells one Channel for any Product, however large Available is. Empty means no limit.
_Avoid_: Cap, quota, share, allocation

**Shortage**:
An Order line that, when it was reserved, no single one of its Order's Channel Warehouses had enough Available for, even if another Warehouse had. Its Reservation then sits in the one of those Warehouses with the most Available, so the fewest units are owed. A person decides what happens next (for example moving the Reservation); Hanza never cancels the Order on its own.
_Avoid_: Oversell, backorder

### Prices

**Base price**:
The price a Product sells for on every Channel, unless an Offer has a Price override. Owned by Hanza; a Product may have none, and then nothing is pushed.
_Avoid_: List price, default price, catalogue price

**Price override**:
A price set in Hanza for one Offer only (the panel calls it the offer price); while set, it wins over the Product's Base price. The way to sell an Offer in a currency other than the Base price's.
_Avoid_: Special price, custom price, channel-specific price

**Effective price**:
The Price override if there is one, else the Base price. What Hanza pushes to the Channel, only when its currency is the Channel price's (ADR 0015).
_Avoid_: Final price, current price

**Channel price**:
The price the Channel reported for an Offer at the last pull. Recorded to learn the Channel's currency, never adopted.
_Avoid_: External price, remote price, marketplace price

### Orders

**Order**:
A Buyer's purchase placed on one Channel. After it reaches Hanza, its progress through fulfilment is owned by Hanza and is not a mirror of the Channel's status.
_Avoid_: Purchase, transaction, checkout form

**Order phase**:
Where an Order is in fulfilment as far as Stock and Channels are concerned: new, processing, shipped or cancelled (the last two are final). One fixed list shared by every organization; Reservations, Channel facts, Needs attention and the status sent to a Channel all depend on it, and each connector translates between it and its Channel's own statuses, in both directions (ADR 0003, ADR 0018). The SDK names it `OrderPhase`.
_Avoid_: Base status, system status, stage, state

**Order status**:
An organization's own label for where an Order is, such as "Waiting for packaging". Each one belongs to exactly one Order phase, and every phase has a default status; moving between two statuses of the same phase changes nothing but the label and is never sent to a Channel (ADR 0018).
_Avoid_: State, stage, step, phase

**Channel fact**:
Something the Channel reports about an Order after it was placed, such as "cancelled by buyer" or "paid". Always recorded as reported. It moves the Order phase accordingly (to the status the Status mapping names, else the phase default), except that an Order that is already shipped or cancelled stays as it is and is marked Needs attention instead (ADR 0003). "Paid" never moves the phase or the status; it ends Awaiting payment.
_Avoid_: External status, remote status

**Awaiting payment**:
A mark on a prepaid Order the Buyer has not paid for yet; never on cash on delivery. The Order is shown and reserves Stock, but a person can only cancel it (or give it another Order status of phase new), not fulfil it, until the Channel reports it paid. A cancelled Order that was never paid is an abandoned checkout and is no longer shown as Awaiting payment. It is a payment state beside the Order phase and status, neither of them (ADR 0015).
_Avoid_: Unpaid status, pending payment, not ready

**Order update**:
What a Channel reports about an Order it cannot (or can no longer) serve whole: new Channel facts and, sometimes, new addresses, such as the delivery address revealed at payment, or a cancellation for an Order merged into another one. It changes only an Order Hanza already has, and its addresses only while the Order is in phase new.
_Avoid_: Patch, delta, Order event

**Order feed**:
The stream of Orders and Order updates Hanza pulls from one Channel. It starts with the Orders open on the Channel when the Connection is made, never with history; when the Channel forgets where Hanza was, it starts again that way and the restart is recorded.
_Avoid_: Order sync, order import, journal (the Channel's own term)

**Needs attention**:
A mark on an Order that a person must look at, for example when the Buyer cancels while it is already being packed, when an Order line could not be matched to a Product, or when the Channel refused the status Hanza sent it.
_Avoid_: Flag, alert, warning

**Unmatched line**:
An Order line that could not be linked to any Product. The Order is still imported; the line reserves nothing until someone links it. While the Order is open (or shipped, where linking corrects Stock) it is Needs attention; once the Order is cancelled it no longer is, since nothing can be fulfilled.
_Avoid_: Unknown product, orphan line

**Buyer**:
The person who placed an Order, kept as a snapshot on that Order together with their addresses. Buyers are not linked across Orders or Channels. Connectors always see the Buyer in plaintext; Hanza stores it sealed and can erase it (see Erasure in the Core glossary).
_Avoid_: Customer, client, user
