# Unpaid Orders reserve Stock, and payment is a Channel fact, not an Order status

A connector may return Orders the Buyer has not paid for yet (`awaitingPayment: true`, issue #5). We decided such an Order is imported and reserves Stock exactly like a ready one, with no expiry kept by Hanza; it is marked Awaiting payment and a person can only cancel it, not fulfil it. The payment arrives as a `paid` Channel fact that clears the mark and touches no Stock; a Buyer who never pays is handled by the Channel cancelling the Order, whose `cancelled` fact releases the Reservation. Marketplaces take the unit off the Offer at purchase, so not reserving would push it back and oversell; a fact keeps ADR 0003's rule that an imported Order changes only through new facts; and a payment state beside the status keeps the fixed status list (to be replaced by organization-defined statuses, issue #1) free of payment.

## Considered options

- An `awaiting_payment` Order status: widens the list issue #1 replaces and mixes payment with fulfilment.
- Reserving only once paid: oversells while the Channel already counts the unit as sold.
- Reading `awaitingPayment` from every later snapshot: breaks ADR 0003 and loses the order between payment and cancellation.

## Consequences

- Units of an Order that is never paid stay reserved until the Channel or a person cancels it; a Hanza-side expiry or reminder is issue #41.
- A connector that reports unpaid Orders must add a `paid` fact when the payment arrives; dropping the flag alone changes nothing, and the conformance kit cannot catch that.
- A `shipped` fact still ships an unpaid Order (the Channel's reality decides Stock); it stays marked Awaiting payment until a `paid` fact. Money for an already cancelled Order marks it Needs attention.
