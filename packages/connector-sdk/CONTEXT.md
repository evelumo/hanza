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

### Prices

**Base price**:
The price a Product sells for on every Channel, unless an Offer has a Price override. Owned by Hanza; a Product may have none, and then nothing is pushed.
_Avoid_: List price, default price, catalogue price

**Price override**:
A price set in Hanza for one Offer only (the panel calls it the offer price); while set, it wins over the Product's Base price. The way to sell an Offer in a currency other than the Base price's.
_Avoid_: Special price, custom price, channel-specific price

**Effective price**:
The Price override if there is one, else the Base price. What Hanza pushes to the Channel, only when its currency is the Channel price's (ADR 0011).
_Avoid_: Final price, current price

**Channel price**:
The price the Channel reported for an Offer at the last pull. Recorded to learn the Channel's currency, never adopted.
_Avoid_: External price, remote price, marketplace price

### Orders

**Order**:
A Buyer's purchase placed on one Channel. After it reaches Hanza, its progress through fulfilment is owned by Hanza and is not a mirror of the Channel's status.
_Avoid_: Purchase, transaction, checkout form

**Order status**:
Where an Order is in fulfilment, from Hanza's point of view. One fixed list shared by every organization; each connector translates between it and its Channel's own statuses, in both directions.
_Avoid_: State, stage, phase

**Channel fact**:
Something the Channel reports about an Order after it was placed, such as "cancelled by buyer". Always recorded as reported. It moves the Order status accordingly, except that an Order that is already shipped or cancelled stays as it is and is marked Needs attention instead (ADR 0003).
_Avoid_: External status, remote status

**Needs attention**:
A mark on an Order that a person must look at, for example when the Buyer cancels while it is already being packed, or when an Order line could not be matched to a Product.
_Avoid_: Flag, alert, warning

**Unmatched line**:
An Order line that could not be linked to any Product. The Order is still imported; the line reserves nothing until someone links it.
_Avoid_: Unknown product, orphan line

**Buyer**:
The person who placed an Order, kept as a snapshot on that Order together with their addresses. Buyers are not linked across Orders or Channels.
_Avoid_: Customer, client, user
