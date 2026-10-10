# Demo walkthrough

Follow the [quick start](quick-start.md) first. This walkthrough uses **Test channel**, an in-memory simulated Channel. It does not call a real marketplace or require an external seller account. UI labels below use English; the user menu at the foot of the sidebar also offers Polish.

## 1. Connect a simulated Channel

Before you start, you can check that the queue and the worker are running: open **Settings → System** and choose **Send test job**. Its result appears on that page a moment later.

Open **Connections → Add connection → Test channel**. Give it a name, such as `Demo channel`, and enter an API key such as `demo-local-1`. This is a stand-in, not a real credential. Use a different key for each demo Channel account: an organization cannot connect the same Channel account twice.

Leave optional rejection settings empty and submit **Add connection**. The worker starts synchronisation. Refresh the Connection page until the sync results appear; **Synchronise now** requests another run.

The seed contains **five Offers and four Orders**. One Order includes an Unmatched line; another has a Buyer cancellation fact. The [seed file](../packages/connectors/fake/src/seed.ts) is the reference for the data.

## 2. Create Products from Offers

Open **Offers** in the sidebar (the list is titled **Offers without a product**; the sidebar shows how many there are). Select the seeded Offers with SKUs and choose **Create products from selected**. Offers can also be linked to existing Products; imports link by SKU where possible.

The Ceramic mug has SKU `FAKE-SKU-1` and a price of `39.99 PLN`. The Sticker set has no SKU, so create its Product separately with **Products → Add product**, then link the Offer using that SKU. The Linen tote bag has no reported price; Hanza does not know that Offer's currency and will not push a price to it.

## 3. Set Stock and inspect Reservations

Open the Ceramic mug Product. In **Stock**, set Stock in its Warehouse to **10** and choose **Save stock**. The first seed Order reserves **2** mugs after its line is matched. With only that Reservation, the Warehouse shows **Stock 10, Reserved 2, Available 8**.

Stock is held per Warehouse. With one Warehouse and the default Channel rules, that Available is what the Channel receives. Warehouse selection, safety buffers and channel limits can reduce what a Channel is told; they do not reduce the physical Stock.

Refresh the Product/Connection pages to inspect the background results. The simulated Channel's external state is in worker memory; the panel's Last pushed values and sync results record what Hanza sent.

## 4. Fulfil an Order

Open **Orders** and find the Order for two Ceramic mugs. Check that the line is matched and there is no Shortage. The button at the top right of the Order moves it on to its next phase: choose **Change to: Processing**, then **Change to: Shipped**, confirming the change when prompted. The other changes of status, cancelling included, are in the **Status** section.

Shipping consumes the reserved goods. In this example, Stock becomes **8**, Reserved becomes **0**, and Available stays **8**. The worker sends the phase change to the Channel. Marking an Order shipped by hand creates no Label; step 5 lets a Carrier do it.

Look at the other Orders to see **Needs attention** and **Unmatched lines**: the notice at the top of such an Order says what each reason asks of you and links to where it is settled. Link the unknown line to a Product when appropriate. A cancelled Order needs no fulfilment and releases its Reservations.

## 5. Ship an Order through a simulated Carrier

Open **Connections → Add connection → Test courier**, give it a name such as `Demo carrier` and submit. It is an in-memory Carrier with no credentials.

Open an Order that is still new or processing, such as the one for three Sticker sets, and link its line under **Lines** if it shows **Unmatched**: a pickup ships only an Order whose lines are all matched, and marks any other as Needs attention. In **Shipments**, choose the service **Fake courier**, enter the parcel's dimensions and weight, and choose **Create shipment**. The seed Orders carry no phone number, which the pickup point service **Fake locker** refuses, as a real locker network would: try it to see a Shipment fail with the Carrier's code.

The Shipment appears as **Waiting for carrier**. The simulated Carrier moves it one status each time it is asked, so choose **Check status** and refresh: at **Ready to send** the **Download label** button gives a PDF. Choose **Check status** again, as if the parcel had been handed over: the Shipment is **In transit**, and the Order moved to **Shipped** on its own, with "The carrier took the parcel" in its history. See [ADR 0024](adr/0024-a-carrier-pickup-ships-the-order.md).

## 6. Try organization-specific statuses

In **Settings → Order statuses**, create an Order status such as `Packed` in the **Processing** phase. Move an Order between statuses within that phase: only its label changes. Stock and outbound Channel behaviour follow the fixed Order phase, not the label. See [ADR 0018](adr/0018-order-statuses-are-labels-within-fixed-phases.md).

## Optional OAuth demo

Uncomment these local stand-ins in the root `.env`, then restart web and worker:

```dotenv
HANZA_CONNECTOR_FAKE_OAUTH_CLIENT_ID=demo-client
HANZA_CONNECTOR_FAKE_OAUTH_CLIENT_SECRET=demo-secret
```

Choose **Test OAuth channel** in Add connection to inspect the sign-in screen. Its verification URL is on `fake-oauth.hanza.test`, a placeholder provider domain, so there is no live approval site to complete this flow manually. The E2E suite simulates approval through its test probe and verifies sign-in and token handling. Use **Test channel** for the manual walkthrough above. These settings do not configure Allegro or any real service.

## Demo limits

The fake Channel's remote state lives in memory and resets when the worker restarts; Hanza's database records remain. Use it for demonstrations and deterministic tests. It does not establish live connector compatibility. The fake Carrier's Shipments reset the same way. Real Channels are [planned](roadmap.md); the InPost connector is the first real one and is not part of this walkthrough.
