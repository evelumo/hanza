# Hanza owns prices; a Channel's price is recorded, never adopted, and never converted

Status: accepted (issue #2)

A price could be kept in Hanza, read back from each Channel, or both. We decided Hanza owns the price, as it owns Stock (ADR 0001): a Product has a Base price, an Offer may have a Price override that wins over it, and the result (the Effective price) is pushed to the Channel with the same per-Offer push sequence and 10-minute sweep as Stock (ADR 0010). The price a Channel reports at `offers.pull` is stored on the Offer as its Channel price and shown, and used only to learn the currency the Channel sells that Offer in. It is never copied into a Base price, not even when a Product is created from that Offer: auto-linking by SKU would then push one Channel's price (say a marketplace price that includes its commission) to every other Channel selling the SKU, without anyone having set it. The panel may offer a Channel price as a suggestion that fills the price form, but only a person saving it sets a price. A price has at most as many decimal places as its currency (2 for PLN, 0 for JPY); more is refused, never rounded. Hanza never converts currencies: a price is pushed only when its currency equals the Channel price's, and an Offer with no price, or whose Channel did not report a currency, gets nothing. Two sources of truth would need a merge rule for every edit, and a guessed exchange rate or currency would publish a wrong price on a live marketplace, which costs more than publishing none.

## Consequences

- A price edited in a Channel's own admin is overwritten the next time Hanza pushes that Offer's price (any change to its Base price, its Price override, its link or its Channel currency). Hanza does not re-push just because the Channel reports a different price; that drift correction is issue #54.
- Until a seller sets a price, nothing is pushed, so connecting a Channel never changes its prices. Removing a price stops pushes; the Channel keeps the last price it was sent.
- An Offer whose Channel sells in another currency needs a Price override in that currency; the panel shows why such an Offer is not pushed.
- `price.push` is an optional capability: a connector that does not implement it keeps working, and its Offers show that prices are not supported.
