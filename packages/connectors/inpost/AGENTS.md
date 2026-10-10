# InPost connector (`@hanza/connector-inpost`)

InPost through its ShipX API: Paczkomat lockers and the InPost courier in Poland. A Carrier (`kind: 'courier'`) with `shipments.create`, `shipments.track`, `shipments.label` and `shipments.cancel`. The design is GitHub issue #126. The documentation is the Confluence space `https://dokumentacja-inpost.atlassian.net/wiki/spaces/PL/` (page ids in brackets below).

**Nothing here has run against InPost yet.** Every cassette is written by hand from the documentation, and every line marked _verify on the sandbox_ is a reading of that documentation, not an observation. See "Fixtures" for how to replace them with a recording.

## The one rule: a create never posts twice

ShipX has no idempotency key, and in the mode this connector uses ("simplified": the request names the `service`) InPost buys the label within seconds of the `POST` and then refuses to cancel. A `POST` repeated after a lost answer is a second paid parcel.

So `shipments.create` searches before it posts (`src/earlier-shipment.ts`, the one function that knows how):

- `reference` (Hanza's Shipment id) is printed on the label and returned in every shipment resource, but it is **not a list filter** and not unique [18153512].
- The search lists `GET /v1/organizations/{id}/shipments?created_at_gteq=<requestedAt − 5 min>&sort_by=created_at&sort_order=asc`, 100 per page, and returns the first shipment whose `reference` equals the request's. `requestedAt` is the same on every repeat. The time is sent as a Unix timestamp, which the documentation allows: no offset to encode or misread. Oldest first, so shipments made meanwhile only append and no page shifts under the search.
- Only when no page has the reference is the shipment posted. A search that fails posts nothing.
- **Limit:** 20 pages, 2000 shipments since the request. Beyond it the call fails as `permanent` and posts nothing: a filter ShipX silently ignored would otherwise walk the organization's whole history, and a second label is worse than a Shipment that waits for a person. An organization that really makes more than 2000 shipments between a request and its retry hits this too.
- **What it does not close:** two creates of the same Shipment in flight at once (the second search runs before the first `POST` lands). The core does not do that: the job is coalesced per Shipment. The same gap opens if a `POST` times out on Hanza's side (30 s) while InPost is still working on it and the retry searches before InPost has stored the shipment.
- A request the connector can tell InPost will refuse (below) is rejected before any request, search included.
- A `reference` shorter than 3 or longer than 100 characters, or with spaces at its ends, is rejected (`reference_unsupported`): ShipX would refuse or could alter it, and an altered reference is never found again.
- If the sandbox shows that an organization that is not a broker may set and filter by `external_customer_id` (an exact-match filter [18153508]), switch `findEarlierShipment` to it. It is not set today.

The conformance replay and the scenario tests serve every recorded answer once (`inpostMatch`: `exhausted: 'error'`), so a second `POST` fails the test instead of getting the first one's answer again.

## Auth and environments

- A static token: `Authorization: Bearer <token>`, with the organization id in the path [18153477]. No expiry or refresh is documented. Credentials: `apiToken`. Config: `environment` (`production` | `sandbox`), `organizationId` (digits), `lockerSendingMethod`, `courierSendingMethod`, `labelType`.
- Production `https://api-shipx-pl.easypack24.net`, sandbox `https://sandbox-api-shipx-pl.easypack24.net`. A token works on its own environment only.
- **Sandbox access:** an account at `https://sandbox-manager.paczkomaty.pl/`; complete the company and invoice data (My Account > Data), then the API tab gives the token and the organization id. Creating a shipment needs funds: top up virtually in the Payments tab. Cash on delivery needs a bank account number in the manager, or the shipment never confirms. Not every production locker exists on the sandbox.
- A wrong token: `401` with `WWW-Authenticate: Bearer … error="invalid_token"` and `{"error":"token_invalid"}` (seen live, 2026-10-10) → `AuthExpiredError`.
- A valid token with the wrong organization id: `403` (FAQ: "access forbidden for this token"), or `404 resource_not_found` on an organization's path → `PermanentError` whose message points at the Organization ID setting. A bare 403 never asks for sign-in (conformance check C14); a 403 that carries `error="invalid_token"` does. _Verify on the sandbox:_ which of the two statuses it is, and the body.
- Error bodies are `{ status, error, message | description, details }` [18153492]. The connector matches the HTTP status first and the `error` key second, never `message`, and never puts a body, the token or receiver data in an error message or a log line.

## Services

| Service id | Destination | Parcel | Cash on delivery |
| --- | --- | --- | --- |
| `inpost_locker_standard` | pickup point (`custom_attributes.target_point`) | preset `small` (A), `medium` (B), `large` (C): ShipX's `parcels.template` | yes |
| `inpost_courier_standard` | address in Poland | dimensions in mm, weight in grams | yes |

`inpost_courier_standard` needs a courier contract on the InPost account; a prepaid account does not have it [47415642] and gets `carrier_unavailable`.

## Request mapping (`src/mapping.ts`)

`sender` is never sent: ShipX uses the organization's data. Requests refused before any call (`rejected`, with the code):

| Code | When |
| --- | --- |
| `receiver_phone_missing`, `receiver_phone_invalid` | no phone, or not a Polish number |
| `receiver_email_missing` | a locker Shipment without an e-mail |
| `destination_country_unsupported` | an address outside `PL` |
| `cod_currency_unsupported`, `cod_amount_invalid` | cash on delivery not in PLN, or with a fraction of a grosz |
| `reference_unsupported` | see above |
| `service_unsupported`, `destination_unsupported`, `parcel_unsupported` | a request that does not fit the service (the core refuses these first) |

Decisions where the documentation is silent or contradicts itself:

- **Phone.** Spaces, dashes and parentheses are dropped, then a leading `+48`, `0048` or `48` when 11 digits remain; the result must be 9 digits. ShipX's own pattern [18153492] also takes prefixed numbers; 9 digits is what every example sends.
- **Name.** The canonical name is one string, split at the last space into `first_name` and `last_name`; `company` goes to `company_name`. ShipX wants "company name and/or first and last name" for a courier. A one-word name cannot be split: next to a company it is sent as `last_name` only; without a company it is sent as `company_name`, so the rule holds and the label does not print the word twice. Issue #126 proposed repeating the word as both names instead. _Verify on the sandbox:_ that `last_name` without `first_name` passes next to a company, and how the label prints a person under `company_name`. The same split is used for lockers, where no name is required.
- **Receiver.** Name, company, e-mail and phone come from the request's `receiver`; the `name`, `company` and `phone` inside the address are not read.
- **Address.** The canonical `street` line (street, building and flat in one) goes whole into `line1`, with `city`, `post_code` and `country_code: "PL"`. ShipX recommends `street` + `building_number` and "still supports" `line1` [18153485, 18153492]. It is not split, because guessing where the street name ends ("ul. 3 Maja 12/5", "os. Bohaterów Września 82") would print a wrong address on a paid label. _Verify on the sandbox:_ that `inpost_courier_standard` takes `line1` alone, and how the label prints it.
- **Post code.** Five digits with or without a dash or spaces are sent as `NN-NNN`; anything else is sent as it is, for ShipX to refuse.
- **Parcel.** A preset is `parcels: { template }` (an object, as in the locker examples). Dimensions are one parcel in an array, with `id: "1"` (required for an array), `dimensions` in `mm` and `weight` in `kg` as strings, as in the examples. Grams become kilograms by moving the decimal point in the digits (`1250` → `"1.25"`), never by dividing. _Verify on the sandbox:_ a weight below 1 kg; the form validation says "greater than or equal to 1" [18153492], the service table says "from 0.01 kg" [18153507].
- **`is_non_standard`.** Set from InPost's size rule [18153485]: a side above 120 cm, or the three sides above 220 cm together. The shape part of the rule (round, irregular) cannot be known. _Verify on the sandbox._
- **Money.** A canonical amount is a decimal string and never becomes a float here. ShipX documents `amount` as a JSON number in every create example (a string appears once, in an update [18153506]). So the body is written with `JSON.rawJSON`: the number token is the amount's own digits (`"12.50"` → `12.50`). Leading zeros are dropped (not valid JSON) and a third or fourth decimal that is 0 is dropped; one that is not 0 is `cod_amount_invalid`, since ShipX could only round it. ShipX's minimum (1 PLN) is left to ShipX. Responses carry floats (`12.5`); the connector reads no amount back. `JSON.rawJSON` needs Node 22, which the repository requires.
- **Insurance.** For a courier Shipment with cash on delivery, `insurance` is set to the same amount (required: "Insurance should be equal or higher than COD"). A locker Shipment gets none, because the documentation requires it for courier services only. _Verify on the sandbox:_ a locker Shipment with cash on delivery and no insurance.
- **`sending_method`.** From `lockerSendingMethod` (default `any_point`) or `courierSendingMethod` (default `dispatch_order`). `parcel_locker` is not offered: it needs a `dropoff_point` chosen per parcel.
- **A pickup point that is not a locker** (`POP-…`): ShipX changes the shipment's `service` to `inpost_locker_customer_service_point` [18153507]. The connector does nothing about it.
- **Label limits** [451903492]: the PDF prints 26 characters of `company_name`, 21 of first and last name together, 56 of the address line, 23 of `city`, and no characters outside Latin scripts. Nothing is cut here.

## What InPost refuses

On the `POST`, a 4xx other than 401, 403, 404, 408 and 429 whose body has an error key is a refusal of this one request, returned as `rejected`:

- `validation_failed`: the code is the first field path in `details` and its first key, such as `target_point.does_not_exist`, `target_point.invalid_box_machine_function` or `receiver.phone.invalid`. Only field names and snake_case keys are used; a sentence or a number in their place is dropped, so a code can never echo a message or Buyer data. _Verify on the sandbox:_ whether `details` is flat (`target_point`, as the FAQ shows) or nested under `custom_attributes`.
- Any other key is the code itself: `no_carriers`, `carrier_unavailable`, and keys not known today. A 400 on a create is about the request, and a Shipment that fails with InPost's key tells a person more than a Connection that fails with "400".
- Except `debt_collection` and `trucker_ID_is_not_set_for_organization`, which are about the account [451903492]: the call fails as `permanent`, naming the key.

## Shipment states

`externalId` is the ShipX id, `trackingNumber` its `tracking_number` (null until `confirmed`), `carrierStatus` the ShipX status name. `shipments.track` is one request for up to 100 ids (`?id=1,2,…&per_page=100`), paged by the answer's own `per_page`, and ignores shipments it did not ask for. Statuses are read from the shipment resource, not from `GET /v1/tracking/{number}`, which returns nothing on the sandbox and answers errors in an undocumented shape.

**A failed purchase has no status of its own.** The shipment stays `created`, `offers_prepared` or `offer_selected`. It is reported `failed` when:

- every offer for its service (or every offer, if none names its service) is `unavailable`: `carrierStatus` is the first `unavailability_reasons[].key` (for example `parcels_size_invalid`), or `offer_unavailable`;
- a transaction has `status: "failure"` and none is `success` or `initiated`: `carrierStatus` is `transaction_failure`.

One unavailable offer beside one that can still be bought is not a failure: `failed` is final. An `expired` offer is left `pending`; the core gives up on a Shipment that never confirms. _Verify on the sandbox_ (no funds; a parcel too large): which of these shapes a failed purchase really has.

**A status the table does not have** (InPost added one) leaves the Shipment out of the `track` answer, so it keeps its status, and logs the name through `ctx.log` (the name only). In `shipments.create`, when the earlier shipment found by reference is in such a status, the call fails as `transient` and posts nothing.

### Status table (`src/statuses.ts`)

All 53 names of `GET /v1/statuses` (the same on production and on the sandbox, 2026-10-10; issue #126 says 54). `src/fixtures/statuses.json` is that answer, and a test compares the table with it both ways.

| Shipment status | InPost statuses |
| --- | --- |
| `pending` | `created`, `offers_prepared`, `offer_selected` |
| `ready` | `confirmed` |
| `in_transit` | `dispatched_by_sender`, `dispatched_by_sender_to_pok`, `collected_from_sender`, `taken_by_courier`, `taken_by_courier_from_pok`, `adopted_at_source_branch`, `sent_from_source_branch`, `adopted_at_sorting_center`, `sent_from_sorting_center`, `adopted_at_target_branch`, `out_for_delivery`, `out_for_delivery_to_address`, `readdressed`, `redirect_to_box`, `canceled_redirect_to_box`, `delay_in_delivery`, `stack_in_customer_service_point`, `stack_in_box_machine`, `unstack_from_customer_service_point`, `unstack_from_box_machine` |
| `awaiting_pickup` | `ready_to_pickup`, `ready_to_pickup_from_pok`, `ready_to_pickup_from_pok_registered`, `ready_to_pickup_from_branch`, `pickup_reminder_sent`, `pickup_reminder_sent_address`, `avizo`, `courier_avizo_in_customer_service_point` |
| `delivery_problem` | `undelivered`, `undelivered_wrong_address`, `undelivered_incomplete_address`, `undelivered_unknown_receiver`, `undelivered_cod_cash_receiver`, `undelivered_no_mailbox`, `undelivered_not_live_address`, `undelivered_lack_of_access_letterbox`, `rejected_by_receiver`, `pickup_time_expired`, `stack_parcel_pickup_time_expired`, `stack_parcel_in_box_machine_pickup_time_expired`, `claimed`, `missing`, `oversized` |
| `delivered` | `delivered`, `return_pickup_confirmation_to_sender` |
| `returned` | `returned_to_sender`, `taken_by_courier_from_customer_service_point` |
| `cancelled` | `canceled` |
| none (kept as it is) | `other` |

Names the groups of issue #126 do not obviously cover, placed by their documented meaning:

- `dispatched_by_sender_to_pok` ("the Sender handed the parcel over to an employee of an InPost point") and `taken_by_courier_from_pok` ("collected the parcel shipped at the Customer Service Point") → `in_transit`: InPost has the parcel.
- `canceled_redirect_to_box` ("rerouting to a parcel machine turned out to be impossible") → `in_transit`: the rerouting was called off, not the parcel.
- `other` ("the parcel is in an unrecognized status") → nothing: InPost itself does not know where the parcel is, so the Shipment keeps its status. It is not logged as unknown.

Names the groups cover whose description reads differently, kept as the issue has them:

- `pickup_reminder_sent_address` → `awaiting_pickup`, though its text is "courier did not find the Recipient at the indicated address".
- `unstack_from_box_machine` → `in_transit`, though its live text is the one of a pickup deadline that passed.
- `undelivered_lack_of_access_letterbox` → `delivery_problem`, though its text says the parcel is on its way back.

No status after `confirmed` can be recorded: the sandbox does not advance a shipment, so this table is tested on hand-written answers only, for good.

## Label and cancel

- **Label:** `GET /v1/shipments/{id}/label?format=pdf&type=<labelType>` [18153509], only from `confirmed` on. Before that the key is `invalid_action` → `TransientError`, on any 4xx, because its HTTP status is not documented (the cassettes assume 400). The content type is not documented either: it is taken from the response header, `application/pdf` when there is none. A JSON body or an empty file is never returned as a Label. `label_generation_failed` and `label_template_not_found` follow their HTTP status. Courier services have only `A6`; _verify on the sandbox_ what `type=normal` gives for a courier shipment.
- **Cancel:** `DELETE /v1/shipments/{id}` [18153504] gives `204` only in `created` or `offers_prepared`, a window of seconds in simplified mode.
  - `invalid_action` → the connector reads the shipment: `canceled` → `cancelled` (a repeat, if ShipX keeps cancelled shipments), anything else → `refused` with `too_late`.
  - `404` → `cancelled`. The id came from this Connection's own create, so a shipment ShipX no longer has is one an earlier cancel removed, and the SDK contract counts a Shipment that is gone as cancelled. The risk: a Connection whose token was replaced by another organization's would read a foreign shipment's 404 the same way.
  - _Verify on the sandbox:_ what a second `DELETE` of a cancelled shipment answers. An unused label is cancelled by InPost itself after 45 days.

## Rate limits

InPost publishes none; the API is behind Cloudflare. Declared, as an **assumption**: per Connection 60 requests a minute and 2 at a time. A create costs 2 requests (search, `POST`), a track 1, a label 1, a cancel 1 or 2. A 429 goes through `errorFromResponse` with its `Retry-After`. To confirm with InPost support.

## Not built (issue #126, non-goals)

Allegro services (`inpost_locker_allegro`, `inpost_courier_allegro`, `inpost_letter_allegro`) and Smart; webhooks (no signature is documented); ordering a courier pickup (`dispatch_orders`); several parcels in one Shipment; insurance as an input; weekend delivery; ZPL and EPL labels; return labels; the other courier services (express, pallet, C2C); `parcel_locker` sending with a drop-off point.

## Fixtures (`src/fixtures/`)

**All cassettes are hand-written from the documentation**, then passed through the SDK's scrubber with this connector's scrub config (`src/testing.ts`), so placeholders, kept headers and the Label file are exactly what the recorder writes. The receivers are fictitious. Messages in error bodies that the documentation does not quote are stand-ins; the connector never reads a message. The `401` body is the one captured live.

| Cassette | What it shows |
| --- | --- |
| `conformance`, `conformance-unauthorized` | the conformance kit's run (S1 to S7, C11) for a locker Shipment: create, repeated create, track, label too early then ready, a rejected create, cancel twice (too late) |
| `create-lost-answer` | the repeat of a create finds the shipment by reference; one `POST` in all |
| `create-search-two-pages` | the search reads on while ShipX pages below 100 |
| `create-unknown-target-point` | `validation_failed` for a locker that does not exist |
| `create-courier-cod` | a courier Shipment with cash on delivery and insurance |
| `track-failed-purchase` | an unavailable offer; a failed transaction |
| `track-status-groups` | one shipment per Shipment status, a status InPost added, a shipment nobody asked for, two pages |
| `label-too-early`, `cancel-in-time`, `cancel-too-late`, `cancel-already-cancelled` | as named |
| `errors` | 401, 403, 404 on the organization, 429 with `Retry-After`, 500 |

**Recording the conformance cassettes from the sandbox:**

1. Put `packages/connectors/inpost/.recording/credentials.json` in place (ignored by git):

   ```json
   { "apiToken": "…", "organizationId": "12345", "targetPoint": "KRA010" }
   ```

   `targetPoint` is a locker that exists on the sandbox. The account needs funds, and it should have made no shipment in the last 5 minutes: the search lists those, and their receivers would shift the placeholder numbers.
2. From the repository root:

   ```sh
   HANZA_RECORD_FIXTURES=1 pnpm --filter @hanza/connector-inpost exec vitest run src/connector.test.ts
   ```

   It creates **one locker shipment that InPost buys** (sandbox funds), under a fresh `reference` and `requestedAt`, and one request InPost refuses. It waits 3 s between label attempts.
3. Read the diff, run `pnpm --filter @hanza/connector-inpost test` without the variable, delete `.recording/`.

A replay reads the organization id, the locker and the two references back from the cassette (`recordedConformance`), so nothing in the test needs editing after a recording. References are scrubbed to `scrubbed-N`; ShipX's answers carry the same placeholder, which is why a replay sends the placeholder as its reference.

Expect these differences from the hand-written cassettes, and fix the connector or this file where they contradict it: ids, tracking number and timestamps; the organization id in every path; `rate` and other fields of the resource; the real status and body of `invalid_action` and of a `validation_failed` for an unknown locker (if InPost accepts that `POST` and only later marks the offer unavailable, conformance check S6 fails, and the rejected fixture needs a request InPost refuses at once); how many label attempts the purchase took; whether the list honours `created_at_gteq` as a Unix time and `sort_order=asc`; the maximum `per_page`; the label's content type.

The scenario cassettes (`src/scenarios.test.ts`) are skipped when recording and are never overwritten. Four of them could be recorded once someone writes the steps (lost answer, unknown target point, label too early, cancel too late); the rest cannot: statuses after `confirmed`, failed purchases on demand, and error statuses.
