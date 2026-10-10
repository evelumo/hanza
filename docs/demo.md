# Demo walkthrough

Follow the [quick start](quick-start.md) first. This walkthrough uses **Test channel**, an in-memory simulated Channel. It does not call a real marketplace or require an external seller account. UI labels below use English; the user menu at the foot of the sidebar also offers Polish.

## 1. Connect a simulated Channel

Before you start, you can check that the queue and the worker are running: open **Settings → System** and choose **Send test job**. Its result appears on that page a moment later.

Open **Connections → Add connection → Test channel**. Give it a name, such as `Demo channel`, and enter an API key such as `demo-local-1`. This is a stand-in, not a real credential. Use a different key for each demo Channel account: an organization cannot connect the same Channel account twice.

Leave optional rejection settings empty and submit **Add connection**. The worker starts synchronisation. Refresh the Connection page until the sync results appear; **Synchronise now** requests another run.

The seed contains **five Offers and four Orders**. One Order includes an Unmatched line; another has a Buyer cancellation fact. The [seed file](../packages/connectors/fake/src/seed.ts) is the reference for the data.

## 2. Create Products from Offers

Open **Offers** in the sidebar (the page is titled **Offers that need attention**; the sidebar shows how many there are). In **Without a product**, select the seeded Offers with SKUs and choose **Create products from selected**. Offers can also be linked to existing Products; imports link by SKU where possible.

The new Products have no Stock yet (unset Stock), so Hanza sends their Offers no number at all until you save it: they move to **Stock not set** on the same page. Telling a Channel 0 for goods Hanza never counted would end the Offers on marketplaces such as Allegro ([ADR 0023](adr/0023-unset-stock-is-no-stock-row.md)).

The Ceramic mug has SKU `FAKE-SKU-1` and a price of `39.99 PLN`. The Sticker set has no SKU, so create its Product separately with **Products → Add product**, then link the Offer using that SKU. The Linen tote bag has no reported price; Hanza does not know that Offer's currency and will not push a price to it.

## 3. Set Stock and inspect Reservations

Open the Ceramic mug Product (**Set stock** beside it in **Stock not set** leads there). In **Stock**, set Stock in its Warehouse to **10** and choose **Save stock**. The first seed Order reserved **2** mugs when its line was matched to the new Product. With only that Reservation, the Warehouse shows **Stock 10, Reserved 2, Available 8**.

Stock is held per Warehouse. With one Warehouse and the default Channel rules, that Available is what the Channel receives. Warehouse selection, safety buffers and channel limits can reduce what a Channel is told; they do not reduce the physical Stock.

Refresh the Product/Connection pages to inspect the background results. The simulated Channel's external state is in worker memory; the panel's Last pushed values and sync results record what Hanza sent.

## 4. Fulfil an Order

Open **Orders** and find the Order for two Ceramic mugs. Check that the line is matched and there is no Shortage. The button at the top right of the Order moves it on to its next phase: choose **Change to: Processing**, then **Change to: Shipped**, confirming the change when prompted. The other changes of status, cancelling included, are in the **Status** section.

Shipping consumes the reserved goods. In this example, Stock becomes **8**, Reserved becomes **0**, and Available stays **8**. The worker sends the phase change to the Channel. These are domain operations; a courier label or physical shipment is not created.

Look at the other Orders to see **Needs attention** and **Unmatched lines**: the notice at the top of such an Order says what each reason asks of you and links to where it is settled. Link the unknown line to a Product when appropriate. A cancelled Order needs no fulfilment and releases its Reservations.

## 5. Try organization-specific statuses

In **Settings → Order statuses**, create an Order status such as `Packed` in the **Processing** phase. Move an Order between statuses within that phase: only its label changes. Stock and outbound Channel behaviour follow the fixed Order phase, not the label. See [ADR 0018](adr/0018-order-statuses-are-labels-within-fixed-phases.md).

## Optional OAuth demo

Uncomment these local stand-ins in the root `.env`, then restart web and worker:

```dotenv
HANZA_CONNECTOR_FAKE_OAUTH_CLIENT_ID=demo-client
HANZA_CONNECTOR_FAKE_OAUTH_CLIENT_SECRET=demo-secret
```

Choose **Test OAuth channel** in Add connection to inspect the sign-in screen. Its verification URL is on `fake-oauth.hanza.test`, a placeholder provider domain, so there is no live approval site to complete this flow manually. The E2E suite simulates approval through its test probe and verifies sign-in and token handling. Use **Test channel** for the manual walkthrough above. These settings do not configure Allegro or any real service.

## Demo limits

The fake Channel's remote state lives in memory and resets when the worker restarts; Hanza's database records remain. Use it for demonstrations and deterministic tests. It does not establish live connector compatibility. Real integrations and shipping are [planned](roadmap.md).
