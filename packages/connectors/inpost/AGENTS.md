# InPost connector (`@hanza/connector-inpost`)

InPost through its ShipX API: Paczkomat lockers and the InPost courier in Poland. A Carrier (`kind: 'courier'`) with `shipments.create`, `shipments.track`, `shipments.label` and `shipments.cancel`. The design is GitHub issue #126. The documentation is the Confluence space `https://dokumentacja-inpost.atlassian.net/wiki/spaces/PL/` (page ids in brackets below).

**What is known, and how.** Three kinds of statement are kept apart here:

- _Observed_: what ShipX's sandbox answered on 2026-10-10 to a prepaid test account (see "The test account"). Dated where it matters.
- From the documentation: page ids in brackets.
- _Verify on the sandbox_: a reading of the documentation that nothing has confirmed yet. Most of what is left needs an account with funds, because **no shipment of the test account was ever bought**: nothing from `confirmed` on has been seen, no Label, no tracking number.

Every cassette is still written by hand, now in the observed shapes. See "Fixtures".

## The one rule: a create never posts twice

ShipX has no idempotency key, and in the mode this connector uses ("simplified": the request names the `service`) InPost goes on to buy the label within a second of the `POST` and then refuses to cancel. A `POST` repeated after a lost answer is a second paid parcel.

So `shipments.create` searches before it posts (`src/earlier-shipment.ts`, the one function that knows how):

- `reference` (Hanza's Shipment id) is printed on the label and returned in every shipment resource, list items included (_observed_), but it is **not a list filter** and not unique [18153512].
- The search lists `GET /v1/organizations/{id}/shipments?created_at_gteq=<requestedAt − 1 h>&sort_by=created_at&sort_order=asc&per_page=100` and returns the first shipment whose `reference` equals the request's. `requestedAt` is the same on every repeat. The time is sent as a Unix timestamp (_observed_: it filters exactly like an ISO 8601 time). Oldest first, so shipments made meanwhile only append.
- Only when the listing was read **to its end** and has no such reference is the shipment posted. "To its end" is counted, not believed: as many different shipments seen as the highest `count` any page gave. Short of that, a page that is empty, shorter than 100, or brings nothing new is a `transient` failure, and nothing is posted. `per_page` in the answer is never read: ShipX echoes what was asked whatever it serves (_observed_ with the `id` filter: asked for 3 a page, it returned 7 on page 1 and repeated three of them on page 2). A `count` that drops between two pages is treated the same way: a shipment was cancelled meanwhile, cancelled shipments leave the listing (_observed_), and one shipment may have slipped from page 2 to page 1 unread.
- A search that fails posts nothing, whatever it fails with (401, 403, 404, 429, 5xx, a redirect, an answer of another shape).
- **Limit:** 20 pages, 2000 shipments in the window. Beyond it the call fails as `permanent` and posts nothing. Because the window starts an hour before the request, a seller who makes more than 2000 shipments an hour cannot create through this connector, and every create costs one request per 100 shipments of the last hour. That is the price of the clock margin below; an exact filter would remove it (last item of this list).
- A request the connector can tell InPost will refuse (below) is rejected before any request, search included.
- A `reference` shorter than 3 or longer than 100 characters, or with spaces at its ends, is rejected (`reference_unsupported`): ShipX would refuse or could alter it, and an altered reference is never found again.
- If a sandbox account that is not a broker may set and filter by `external_customer_id` (an exact-match filter [18153508]), switch `findEarlierShipment` to it. Not tried; it is not set today.

### The listing lags behind the `POST` (_observed_)

A new shipment is missing from every listing for a few seconds. Only two lookups have it at once: `GET /v1/shipments/{id}` and the `id` filter of the list (both answered about 0.1 s after the `POST`'s answer, six times out of six). The `created_at_gteq` search, the same search with an ISO time, the plain list and the list sorted by `created_at` all lag alike.

Measured six times: one `POST`, then the search every 0.2 to 0.3 s until it had the shipment.

| Shipment | Last search without it | First search with it | The same, counted from when the `POST` was sent |
| --- | --- | --- | --- |
| 14588074 | 4.57 s | 4.79 s | 5.18 s |
| 14588075 | 4.83 s | 5.09 s | 5.41 s |
| 14588076 | 1.70 s | 2.01 s | 2.36 s |
| 14588077 | 2.00 s | 2.28 s | 2.63 s |
| 14588078 | 0.62 s | 0.97 s | 1.35 s |
| 14588079 | 4.67 s | 4.96 s | 5.36 s |

(Seconds after the `POST`'s answer arrived, by the time each search was sent.) The six shipments became visible at wall-clock seconds :01, :46, :56, :01, :06 and :16, which reads like a listing refreshed every 5 seconds: a lag anywhere between 0 and about 5.4 s. The answers are not cached (`x-proxy-cache: MISS`, a new request id each time). The first recording met the same thing: a search half a second after a `POST` was empty, the connector posted again, and InPost made a second shipment.

**The connector cannot close this by itself**: it has no memory, the reference is not a filter, and the lookups that do not lag need the id that was lost. It relies on a rule of the SDK contract: **the core does not repeat a create whose outcome it does not know sooner than 5 minutes after the earlier call began.** Against the worst sample (5.4 s) that leaves a factor of 55. What is not known: the lag on production, and under load. If it ever comes near minutes, this design does not hold and has to be rethought.

The remaining gap is the one the core covers: two creates of the same Shipment in flight at once (the job is coalesced per Shipment, under a lease).

### The two clocks

`requestedAt` is Hanza's clock, `created_at` InPost's. With Hanza's ahead by more than the margin, the earlier shipment falls before the window and the repeat posts again. Two defences:

- The margin is **1 hour**.
- The `Date` header of the listing's answer is compared with this server's clock before "none" is concluded: more than **5 minutes** apart is a `permanent` failure that says the server's clock is wrong, and nothing is posted. (_Observed_: ShipX sends `Date`; it was 0.25 s from the local clock.) A shipment that was found is returned whatever the clocks say.

The margin is far above the tolerance on purpose: it also covers a `requestedAt` stamped by another machine than the worker that asks. An answer without a readable `Date` skips the check, which is what a replayed cassette does, since the recorder keeps no `Date` header; ShipX itself always sent one.

The conformance replay and the scenario tests serve every recorded answer once (`inpostMatch`: `exhausted: 'error'`), so a second `POST` fails the test instead of getting the first one's answer again.

## Auth and environments

- A static token: `Authorization: Bearer <token>`, with the organization id in the path [18153477]. No expiry or refresh is documented. Credentials: `apiToken`. Config: `environment` (`production` | `sandbox`), `organizationId` (digits), `lockerSendingMethod`, `courierSendingMethod`, `labelType`.
- Production `https://api-shipx-pl.easypack24.net`, sandbox `https://sandbox-api-shipx-pl.easypack24.net`. A token works on its own environment only.
- **Sandbox access:** an account at `https://sandbox-manager.paczkomaty.pl/`; complete the company and invoice data (My Account > Data), then the API tab gives the token and the organization id. Creating a shipment needs funds: top up virtually in the Payments tab. Cash on delivery needs a bank account number and company data in the manager, or the purchase fails. Not every production locker exists on the sandbox.
- A wrong token: `401` with `WWW-Authenticate: Bearer … error="invalid_token"` and `{"status":401,"error":"token_invalid","message":"Token is missing or invalid.","details":{}}` (_observed_) → `AuthExpiredError`.
- A valid token with the wrong organization id: `403` with `{"status":403,"error":"forbidden","message":"Access forbidden for this token.","details":{}}` (_observed_) → `PermanentError` whose message points at the Organization ID setting. A `404 resource_not_found` on an organization's path is read the same way [18153501]. A bare 403 never asks for sign-in (conformance check C14); a 403 that carries `error="invalid_token"` does.
- A shipment that does not exist or belongs to another organization: `404` with `{"status":404,"error":"resource_not_found","message":"Resource not found.","details":{}}` (_observed_, for the shipment and for its label).
- Error bodies are `{ status, error, message, details }` [18153492]; `details` may be `null` (_observed_). The connector matches the HTTP status first and the `error` key second, never `message`, and never puts a body, the token or receiver data in an error message or a log line.
- **Redirects are never followed** (`redirect: 'error'` on every request). A 307 or 308 on the create would post the receiver's name, phone, e-mail and address, and the token, to wherever `Location` points. A redirect is a `permanent` failure, whether the transport refuses it (Node rejects with a `TypeError` whose cause is "unexpected redirect") or hands the 3xx over (a replayed cassette does).

### The test account (2026-10-10)

The recording account is prepaid. What it cannot show:

- **No funds at the time.** Every purchase failed with `debt_collection`, so no shipment reached `confirmed`: no tracking number, no Label, no status after the purchase.
- **No `inpost_courier_standard`.** Its services are `inpost_locker_standard`, `inpost_locker_economy`, `inpost_locker_allegro`, `inpost_locker_pass_thru`, the `_smart` ones, `inpost_courier_allegro`, `inpost_courier_c2c` and `inpost_letter_allegro`. The courier path is untried.
- **No bank account, no company data**, so no cash on delivery: the shipment is accepted and its purchase then fails with `company_data_missing`.

## Services

| Service id | Destination | Parcel | Cash on delivery |
| --- | --- | --- | --- |
| `inpost_locker_standard` | pickup point (`custom_attributes.target_point`) | preset `small` (A), `medium` (B), `large` (C): ShipX's `parcels.template` | yes |
| `inpost_courier_standard` | address in Poland | dimensions in mm, weight in grams | yes |

`inpost_courier_standard` needs a courier contract on the InPost account; a prepaid account does not have it [47415642] and is refused with `missing_trucker_id` (_observed_; below).

## Request mapping (`src/mapping.ts`)

`sender` is never sent: ShipX uses the organization's data. Requests refused before any call (`rejected`, with the code):

| Code | When |
| --- | --- |
| `receiver_phone_missing`, `receiver_phone_invalid` | no phone, or not a Polish number |
| `receiver_email_missing` | a locker Shipment without an e-mail |
| `destination_country_unsupported` | an address outside `PL` |
| `cod_currency_unsupported`, `cod_amount_invalid`, `cod_amount_too_small` | cash on delivery not in PLN; not a plain decimal or with a fraction of a grosz; below 1 PLN, the least ShipX takes [18153492] |
| `reference_unsupported` | see above |
| `service_unsupported`, `destination_unsupported`, `parcel_unsupported` | a request that does not fit the service (the core refuses these first) |

Decisions where the documentation is silent or contradicts itself:

- **Phone.** Spaces, dashes and parentheses are dropped, then a leading `+48`, `0048` or `48` when 11 digits remain; the result must be 9 digits. ShipX's own pattern [18153492] also takes prefixed numbers; 9 digits is what every example sends.
- **Name.** The canonical name is one string, split at the last space into `first_name` and `last_name`; `company` goes to `company_name`. ShipX wants "company name and/or first and last name" for a courier. A one-word name cannot be split: next to a company it is sent as `last_name` only; without a company it is sent as `company_name`, so the rule holds and the label does not print the word twice. Issue #126 proposed repeating the word as both names instead. _Verify on the sandbox_ (an account with the courier service): that `last_name` without `first_name` passes next to a company, and how the label prints a person under `company_name`. The same split is used for lockers, where no name is required.
- **Receiver.** Name, company, e-mail and phone come from the request's `receiver`; the `name`, `company` and `phone` inside the address are not read.
- **Address.** The canonical `street` line (street, building and flat in one) goes whole into `line1`, with `city`, `post_code` and `country_code: "PL"`. ShipX recommends `street` + `building_number` and "still supports" `line1` [18153485, 18153492]. It is not split, because guessing where the street name ends ("ul. 3 Maja 12/5", "os. Bohaterów Września 82") would print a wrong address on a paid label. _Verify on the sandbox_ (courier service): that `inpost_courier_standard` takes `line1` alone, and how the label prints it.
- **Post code.** Five digits with or without a dash or spaces are sent as `NN-NNN`; anything else is sent as it is, for ShipX to refuse.
- **Parcel.** A preset is `parcels: { template }` (an object; _observed_: accepted, and answered as one parcel of the template's size and 25 kg). Dimensions are one parcel in an array, with `id: "1"` (required for an array), `dimensions` in `mm` and `weight` in `kg` as strings, as in the examples. Grams become kilograms by moving the decimal point in the digits (`1250` → `"1.25"`), never by dividing. _Verify on the sandbox_ (courier service): a weight below 1 kg; the form validation says "greater than or equal to 1" [18153492], the service table says "from 0.01 kg" [18153507].
- **`is_non_standard`.** Set from InPost's size rule [18153485]: a side above 120 cm, or the three sides above 220 cm together. The shape part of the rule (round, irregular) cannot be known. _Verify on the sandbox_ (courier service).
- **Money.** A canonical amount is a decimal string and never becomes a float here. ShipX documents `amount` as a JSON number in every create example (a string appears once, in an update [18153506]). So the body is written with `JSON.rawJSON`: the number token is the amount's own digits (`"12.50"` → `12.50`). `plnAmount` itself refuses anything that is not digits with at most one point between them (`1.2.3`, `.5`, `1e3`), whatever the caller's schema let through. Leading zeros are dropped (not valid JSON) and a third or fourth decimal that is 0 is dropped; one that is not 0 is `cod_amount_invalid`, since ShipX could only round it. Responses carry floats (`12.5`); the connector reads no amount back. `JSON.rawJSON` needs Node 22, which the repository requires.
- **Insurance.** With cash on delivery, `insurance` is set to the same amount, **for both services**. The parameter table requires it for courier services only [18153492], but the documentation's own locker example sends it [18153501] and three FAQ pages say "the package must be insured for a minimum of the COD value" without naming a service [451903492, 52428808, 53706753]. _Observed_: a locker shipment with `cod` and an equal `insurance` is accepted (201) and both come back in the resource. _Verify on a sandbox account with a bank account_: that it is bought, and whether a locker shipment with cash on delivery and no insurance would have been refused.
- **`sending_method`.** From `lockerSendingMethod` (default `any_point`) or `courierSendingMethod` (default `dispatch_order`). `parcel_locker` is not offered: it needs a `dropoff_point` chosen per parcel.
- **A pickup point that is not a locker** (`POP-…`): ShipX changes the shipment's `service` to `inpost_locker_customer_service_point` [18153507]. The connector does nothing about it.
- **Label limits** [451903492]: the PDF prints 26 characters of `company_name`, 21 of first and last name together, 56 of the address line, 23 of `city`, and no characters outside Latin scripts. Nothing is cut here.

## What InPost refuses on a create

`POST` answers `201` with `Location` and the resource in `status: "created"` (_observed_). A 401, 403, 404, 408, 429, a 5xx or a redirect is a failure of the call, thrown, on the `POST` as on the search before it, whatever the body says: never `rejected`.

Any other 4xx with a ShipX error body is sorted by its `error` key (`src/refusals.ts`):

| Key | Outcome | Why |
| --- | --- | --- |
| `validation_failed` | `rejected`, with a code built from `details` (below) | this request's fields |
| `carrier_unavailable` | `rejected` `carrier_unavailable` | "no carriers contracted providing the requested service" [18153501]: about the service this request names |
| `missing_trucker_id`, or `trucker_ID_is_not_set_for_organization` as the key | `rejected` `missing_trucker_id` | _observed_ for `inpost_courier_standard` on the account without a courier contract: `{"status":400,"error":"missing_trucker_id","message":"trucker_ID_is_not_set_for_organization","details":null}`. The FAQ's "error" is the message; the key is documented nowhere |
| `debt_collection`, `no_carriers` | thrown, `permanent`, naming the key | the account: unpaid invoices or no credit [451903492, 53706753]; "the organization has no carriers contracted" [18153501]. Every Shipment would get the same answer |
| any other key | thrown, `permanent`, **not naming it**; the key goes to `ctx.log` if it reads as one | see below |

**The default for a key nobody has listed is to fail the call, not the Shipment.** `rejected` is final for a Shipment. An unknown key may be about the account as easily as about the request (`missing_trucker_id` was unknown until the sandbox answered it), and as `rejected` an account problem would fail Shipments one by one while the Connection looked healthy. Thrown, nothing is lost: nothing was made at InPost (a 4xx with an error body), the Shipment waits and is asked for again, the Connection shows as failing, and a person reads the key in the worker's log and adds it to one of the two lists. The cost when the key was about the request after all: that one Shipment waits (24 hours at most, then `carrier_timeout`) instead of failing at once with a telling code.

`trucker_ID_is_not_set_for_organization` was listed as an account error before. It is refused as `rejected` now: it is the service the request names that the account lacks, the account's locker service keeps working, and a Connection marked failing for it would hold back Shipments that have nothing wrong.

`debt_collection` was not seen as the answer to a `POST`. On the prepaid test account without funds the `POST` is accepted and the _payment_ fails with it (next section). The FAQ's "API returns error debt_collection" may be a postpaid account's answer.

### Codes of `validation_failed`

_Observed_ for a locker that does not exist: `400` with `details: {"custom_attributes":[{"target_point":["does_not_exist"]}]}`: nested under the form, through an array, not the flat `{"target_point":[…]}` of the FAQ. Both give `target_point.does_not_exist`.

The code is the path of the first field in `details` that carries a known validation key, then that key: `receiver.phone.invalid`, `parcels.weight.amount.too_small`, `target_point.invalid_box_machine_function`. Array indexes are dropped, and so is the `custom_attributes` wrapper.

**A code can echo nothing, because nothing in it comes from the answer.** Codes are stored with the Shipment in plaintext and are never erased, and ShipX does put input into its keys (_observed_: `?id=abc` on the list is answered `{"shipment":["id_abc_does_not_exist"]}`). So:

- a field name counts only if it is one this connector sends (the list in `src/refusals.ts`);
- a key counts only if it is one of `required`, `invalid`, `invalid_format`, `too_short`, `too_long`, `too_small`, `too_big`, `not_a_number`, `not_an_integer`, `does_not_exist`, `invalid_box_machine_function`;
- anything else (a field ShipX names that was never sent, a key outside the list, a sentence, a number) is skipped, and when nothing is left the code is `validation_failed`.

A new validation key therefore shows as plain `validation_failed` until it is added to the list.

## Shipment states

`externalId` is the ShipX id, `trackingNumber` its `tracking_number` (null until `confirmed`), `carrierStatus` the ShipX status name. Statuses are read from the shipment resource, not from `GET /v1/tracking/{number}`, which returns nothing on the sandbox and answers errors in an undocumented shape.

**A ShipX id is digits, and nothing else is taken for one.** The response schema refuses any other id (`..`, a path), so an id InPost returned cannot steer a later request, and `label`, `cancel` and `track` check the ids they are given before they build a path or a query: `label` fails as `permanent`, `cancel` answers `refused` `not_found`, `track` leaves the Shipment out. None of them makes a request for such an id.

`shipments.track` is one request for up to 100 ids (`?id=1,2,…&per_page=100`). _Observed_: the filter takes a comma list (2 and 7 ids; 100 could not be tried, the account had 13 shipments), leaves out ids of other organizations and ids that do not exist, and answers `400 validation_failed` to an id that is not a number. An ignored filter shows as a `count` above the number of ids asked: `permanent`. Pages are read until every id was seen, `count` shipments were seen, or a page brings nothing new, whatever size ShipX makes them. Shipments nobody asked for are ignored.

### A purchase that does not go through

A failed purchase has no status of its own: the shipment stays `created`, `offers_prepared` or `offer_selected`.

_Observed_ every time, on twelve shipments, with no funds: `created` → `offers_prepared` → `offer_selected` within 0.1 to 0.5 s of the `POST`, then, within another half second,

```json
"status": "offer_selected", "tracking_number": null,
"offers": [{ "status": "selected", "expires_at": "…", "unavailability_reasons": null, … }],
"transactions": [{ "status": "failure", "details": { "status": 422, "error": "debt_collection", "message": "debt_collection", "details": {} }, … }]
```

and it stays like that. With cash on delivery on the account without company data the key was `company_data_missing` (message `customer_lack_of_address_data`), and its inner `details` held the **account owner's e-mail address**: the connector keeps the `error` key of a transaction and nothing else of it.

**The rule: a Shipment fails only when no offer can still be bought.**

- While any offer for the shipment's service (or any offer, if none names its service) is in a status other than `unavailable` or `expired`, the Shipment is `pending`. If a payment failed and none succeeded or is under way, `carrierStatus` is that payment's error key (`debt_collection`), or `transaction_failure` when it has none that reads as a key, so the seller sees what it waits for.
- When every such offer is `unavailable` or `expired`, the Shipment is `failed`, which is final: `carrierStatus` is the first `unavailability_reasons[].key` that reads as a key (for example `parcels_size_invalid`), else `offer_expired` when all of them expired, else `offer_unavailable`.

**Why a failed payment is not final.** The documentation says an offer stays `selected` "if a previous payment attempt was unsuccessful" and can be paid for again [18153611], and the sandbox shows that very shape. A Shipment reported `failed` is one Hanza stops following; if the payment went through afterwards, InPost would hold a paid label nobody tracks, and the replacement the seller made meanwhile would be a second parcel. `pending` loses nothing: the core gives up on a Shipment that is not confirmed after 24 hours (`carrier_timeout`).

**What is not known**, because the account never got funds:

- Whether InPost pays for a stuck shipment by itself once the account has funds, or only on `POST /v1/shipments/{id}/buy`. The two shipments made at 22:10 were unchanged at 22:55: still `offer_selected`, one failed transaction each. That only says InPost does not try again by itself while there are no funds.
- Whether an offer past its `expires_at` can still be bought. The documentation says offers "are available 5 minutes" and names an `offer_expired` error [18153611]; _observed_, the offers kept `status: "selected"` 40 minutes after their `expires_at`, and no offer in status `expired` was ever seen. The connector goes by the status, not by the time: reading `expires_at` would be a second comparison of two clocks, and would end Shipments on a guess.
- The shape of an unavailable offer (`unavailability_reasons`): from the documentation only.

Keys taken from inside a resource (a payment's error, an unavailability reason) must be lower-case letters and `_` only. A key with digits in it could carry a phone number or a locker code.

**A status the table does not have** (InPost added one), or one it has as "says nothing" (`other`, `missing`):

- in `shipments.track` the Shipment is left out of the answer, so it keeps its status, and a new name is logged through `ctx.log` (the name only);
- in `shipments.create`, when the earlier shipment found by reference is in such a status, the answer is `created` with the least that is true: `ready` when it has a tracking number (InPost bought the label), else `pending`, with the status name as `carrierStatus`. Never a status that says the Carrier holds the parcel: that would ship the Order on a guess. (It used to throw `transient`, which threw on every repeat until the core failed, after 24 hours, a Shipment InPost may well have bought.)

### Status table (`src/statuses.ts`)

All 53 names of `GET /v1/statuses` (the same on production and on the sandbox, 2026-10-10; issue #126 says 54). `src/fixtures/statuses.json` is that answer, and a test compares the table with it both ways.

| Shipment status | InPost statuses |
| --- | --- |
| `pending` | `created`, `offers_prepared`, `offer_selected` |
| `ready` | `confirmed` |
| `in_transit` | `dispatched_by_sender`, `dispatched_by_sender_to_pok`, `collected_from_sender`, `taken_by_courier`, `taken_by_courier_from_pok`, `adopted_at_source_branch`, `sent_from_source_branch`, `adopted_at_sorting_center`, `sent_from_sorting_center`, `adopted_at_target_branch`, `out_for_delivery`, `out_for_delivery_to_address`, `readdressed`, `redirect_to_box`, `canceled_redirect_to_box`, `delay_in_delivery`, `stack_in_customer_service_point`, `stack_in_box_machine`, `unstack_from_customer_service_point`, `unstack_from_box_machine` |
| `awaiting_pickup` | `ready_to_pickup`, `ready_to_pickup_from_pok`, `ready_to_pickup_from_pok_registered`, `ready_to_pickup_from_branch`, `pickup_reminder_sent`, `avizo`, `courier_avizo_in_customer_service_point` |
| `delivery_problem` | `undelivered`, `undelivered_wrong_address`, `undelivered_incomplete_address`, `undelivered_unknown_receiver`, `undelivered_cod_cash_receiver`, `undelivered_no_mailbox`, `undelivered_not_live_address`, `undelivered_lack_of_access_letterbox`, `rejected_by_receiver`, `pickup_time_expired`, `stack_parcel_pickup_time_expired`, `stack_parcel_in_box_machine_pickup_time_expired`, `claimed`, `oversized`, `pickup_reminder_sent_address`, `taken_by_courier_from_customer_service_point` |
| `delivered` | `delivered`, `return_pickup_confirmation_to_sender` |
| `returned` | `returned_to_sender` |
| `cancelled` | `canceled` |
| none (kept as it is) | `other`, `missing` |

Every status from `in_transit` to `returned` says the Carrier has, or had, the parcel, and the first of them **ships the Order** (ADR 0024). So a name goes into one of those rows only when its own text says InPost held the parcel.

Names the groups of issue #126 do not obviously cover, placed by their documented meaning:

- `dispatched_by_sender_to_pok` ("the Sender handed the parcel over to an employee of an InPost point") and `taken_by_courier_from_pok` ("collected the parcel shipped at the Customer Service Point") → `in_transit`: InPost has the parcel.
- `canceled_redirect_to_box` ("rerouting to a parcel machine turned out to be impossible") → `in_transit`: the rerouting was called off, not the parcel.
- `other` ("the parcel is in an unrecognized status") → nothing: InPost itself does not know where the parcel is, so the Shipment keeps its status. It is not logged as unknown.

Names placed differently from issue #126, by their text in the live list:

- `missing` → nothing (the issue: `delivery_problem`). Its title and description are "translation missing" in the live list, and it names no origin status: nothing says InPost ever held the parcel, and `delivery_problem` would ship the Order.
- `taken_by_courier_from_customer_service_point` → `delivery_problem` (the issue: `returned`). "The time for you to collect the parcel has passed. It has been picked up by a courier … and will soon be on its way back to the Sender": not back yet, and `returned` is final. `returned_to_sender` follows when it is.
- `pickup_reminder_sent_address` → `delivery_problem` (the issue: `awaiting_pickup`). Its text is "InPost courier did not find the Recipient at the indicated address": a failed delivery, not a parcel waiting at a point.

Names kept as the issue has them although their description reads differently:

- `unstack_from_box_machine` → `in_transit`, though its live text is the one of a pickup deadline that passed.
- `undelivered_lack_of_access_letterbox` → `delivery_problem`, though its text says the parcel is on its way back.
- `oversized` → `delivery_problem`. "The parcel does not fit into the locker of the parcel machine": **who holds the parcel then is not documented**. If it is a parcel the sender could not put into a locker, InPost never had it, and this row ships the Order wrongly. To ask InPost.

No status after `confirmed` can be recorded: the sandbox does not advance a shipment, so this table is tested on hand-written answers only, for good.

## Label and cancel

- **Label:** `GET /v1/shipments/{id}/label?format=pdf`, with `&type=A6` when the setting is `A6` and **no `type` at all when it is `normal`**: without `type` ShipX returns a normal label, and A6 for courier services, which have no normal one [18153509]; what an explicit `type=normal` does for a courier shipment is not documented, so it is never sent.
  - Only from `confirmed` on. Before: `400` with `{"error":"invalid_action","message":"shipment_status_incorrect","details":{"action":"get_label","shipment_status":"offer_selected",…}}` (_observed_) → `TransientError`, by the key, on any 4xx. For a cancelled shipment the answer is another one: `400 validation_failed` with `{"tracking_number":["you_can_not_generate_labels_for_unpaid_shipments"]}` (_observed_) → `permanent`.
  - The file says what it is, not the header. The body must begin with `%PDF-`, and is then returned as `application/pdf` whatever `Content-Type` says. Anything else answered with 200 (an error page of the edge in front of ShipX, JSON, an empty body) is a `TransientError`: the core stores a Label once and for good.
  - At most 5 MB, the core's limit: a `Content-Length` above it is not read at all, and a body that turns out longer is dropped where it passes it. Both `permanent`.
  - `label_generation_failed` and `label_template_not_found` follow their HTTP status.
  - _Verify on the sandbox_ (funds): the real content type and size of a label, and that a locker shipment without `type` gets the normal one.
- **Cancel:** `DELETE /v1/shipments/{id}` [18153504], possible only in `created` or `offers_prepared`. _Observed_: that is the first 0.1 to 0.5 s after the `POST`. Of four cancels sent 0.1 s after the `POST`'s answer, one came in time.
  - `204` → `cancelled`. No other success is believed: on another 2xx the shipment's status decides, and one that is not `canceled` is a `transient` failure.
  - `invalid_action` (`400`, with `details.action: "cancel"` and `details.shipment_status`; _observed_) → the connector reads the shipment by id: `canceled` → `cancelled`; any other status → `refused` `too_late`; not listed → `refused` `not_found`. This is also the repeat of a cancel: ShipX **keeps** a cancelled shipment, as `canceled`, and answers a second `DELETE` with `invalid_action` and `shipment_status: "canceled"` (_observed_). It is never a 404.
  - `404` → `refused` `not_found`, with any body. The documentation's 404 is "no access to the resource or the shipment does not exist": a token of another organization gets it for a label that is bought. It used to be read as `cancelled`.
  - An unused label is cancelled by InPost itself after 45 days.

### A cancel that InPost takes back (_observed_ once, unresolved)

Shipment 14588080: `POST` at 22:31:40.975; `DELETE` 0.1 s after the answer → `204`; read at once: `status: "canceled"` (`updated_at` 22:31:41.395); a second `DELETE` → `invalid_action`, `shipment_status: "canceled"`. Eight seconds later the same shipment was **`offer_selected`** (`updated_at` 22:31:41.758), with a selected offer and a payment attempt that failed only for lack of funds. InPost's own purchase, already running when the cancel arrived, wrote over it 0.36 s later.

So in simplified mode a `204` can be followed by InPost buying the label anyway, and the only moment a cancel is accepted at all is the moment that purchase runs. The connector reports `cancelled` for that `204`, which is final in Hanza: **on an account with funds this may be a paid label for a Shipment Hanza shows as cancelled.** The exposure is small (a person does not cancel within half a second of the create; later InPost answers `invalid_action`), but it is not closed. Once seen, with no funds, on the sandbox. Open, for the owner of #126:

- have the connector read the shipment again a few seconds after a `204` and report `cancelled` only if it is still `canceled` (how long is enough is a guess);
- or have the core track a cancelled Shipment once more later;
- or not offer `shipments.cancel` for InPost in simplified mode.

Such a shipment also **leaves the listings**: 24 minutes later 14588080 was still alive and still in neither the search nor the plain list. Cancelled shipments are listed nowhere (`status=canceled` gives 0); only `GET /v1/shipments/{id}` and the `id` filter have them.

## Rate limits

InPost publishes none; the API is behind Cloudflare. Declared, as an **assumption**: per Connection 60 requests a minute and 2 at a time. A create costs 1 request for every 100 shipments the organization made in the last hour (at least 1), then the `POST`; a track 1; a label 1; a cancel 1 or 2. A 429 goes through `errorFromResponse` with its `Retry-After`. To confirm with InPost support. Nothing was limited during the probes (three or four requests a second for 5 s, several times).

## Paging (_observed_)

- The maximum `per_page` is 100: asked for 500, the envelope says `per_page: 100`.
- The default sort is `id` descending (the `href` of the envelope shows it), not `created_at` as documented.
- A filter ShipX does not know is dropped from the echoed `href` without an error; a known one is kept there.
- `page=0` is answered as page 1. A page past the end is `200` with `items: []` and the full `count`.
- The envelope is `{ href, count, page, per_page, items }`. The connector reads `count` and `items`.

## Not built (issue #126, non-goals)

Allegro services (`inpost_locker_allegro`, `inpost_courier_allegro`, `inpost_letter_allegro`) and Smart; webhooks (no signature is documented); ordering a courier pickup (`dispatch_orders`); several parcels in one Shipment; insurance as an input; weekend delivery; ZPL and EPL labels; return labels; the other courier services (express, pallet, C2C); `parcel_locker` sending with a drop-off point.

## Fixtures (`src/fixtures/`)

**All cassettes are hand-written**, from fictitious data, then passed through the SDK's scrubber with this connector's scrub config (`src/testing.ts`), so placeholders, kept headers and the Label file are exactly what the recorder writes. Where the sandbox answered, the shapes are its own, word for word: the `201` with `Location`, the resource and the list envelope with `href` and `Link`, `offer_selected` with a failed payment, the nested `validation_failed`, `invalid_action` with its `details`, the `401`, `403` and `404` bodies. Hand-written from the documentation alone: everything from `confirmed` on (tracking numbers, bought offers, the Label), unavailable and expired offers, the courier shipment, statuses after the purchase, the 429 and the 500.

A first recording of the conformance run was made on 2026-10-10 and not committed: without funds it never reached a Label, and its repeated create met the listing's lag and made a second shipment.

| Cassette | What it shows |
| --- | --- |
| `conformance`, `conformance-unauthorized` | the conformance kit's run (S1 to S7, C11) for a locker Shipment: create, repeated create, track, label too early then ready, a rejected create, cancel twice (too late). The unauthorized one also holds the search, for the auth checks the kit is to run on `shipments.create` |
| `create-lost-answer` | the repeat of a create finds the shipment by reference; one `POST` in all |
| `create-list-lag` | as on the sandbox: the search right after the `POST` is empty; the one after the wait finds the shipment; one `POST` in all |
| `create-search-inconsistent` | the listing counts five shipments and serves two: no `POST` |
| `create-clock-skew` | the answer's `Date` an hour from the server's clock: no `POST`. The `date` header is put in by hand; a recording keeps none |
| `create-untranslatable-status` | the repeat finds the shipment in a status InPost added: `created`, `ready`, no `POST` |
| `create-unknown-target-point` | `validation_failed`, nested, for a locker that does not exist |
| `create-redirect` | a 307 on the `POST`: one `POST`, to InPost, and nothing to the other host |
| `create-courier-cod`, `create-locker-cod` | cash on delivery with insurance, for each service (hand-written: the account could do neither) |
| `track-failed-purchase` | the failed payment as observed (`debt_collection`, `company_data_missing`); an unavailable offer; an expired one |
| `track-status-groups` | one shipment per Shipment status, a status InPost added, a shipment nobody asked for, an id InPost does not have, two pages |
| `label-too-early`, `label-not-pdf` | `invalid_action`; an HTML page answered with 200, then the PDF |
| `cancel-in-time`, `cancel-too-late`, `cancel-not-found` | 204 and its repeat (kept as `canceled`); `invalid_action` once InPost went on; 404 |
| `errors` | 401, 403, 404 on the organization, 429 with `Retry-After`, 500 |

**Recording the conformance cassettes from the sandbox.** It needs an account **with funds**, and the SDK's kit with `shipment.repeatWaitMs` (not in the kit yet: without it the repeated create is sent at once, meets the lag and posts a second parcel).

1. Put `packages/connectors/inpost/.recording/credentials.json` in place (ignored by git):

   ```json
   { "apiToken": "…", "organizationId": "12345", "targetPoint": "KRA010" }
   ```

   `targetPoint` is a locker that exists on the sandbox. The account should have made **no shipment in the last hour**: the search lists those, and their receivers would shift the placeholder numbers.
2. Set `repeatWaitMs` in `src/connector.test.ts` above the lag (10 s; the `TODO` marks the place).
3. From the repository root:

   ```sh
   HANZA_RECORD_FIXTURES=1 pnpm --filter @hanza/connector-inpost exec vitest run src/connector.test.ts
   ```

   It creates **one locker shipment that InPost buys** (sandbox funds), under a fresh `reference` and `requestedAt`, and one request InPost refuses. It waits 3 s between label attempts. The cassettes are written even when a check fails: do not commit a recording that did not reach a Label.
4. Read the diff, run `pnpm --filter @hanza/connector-inpost test` without the variable, delete `.recording/`.

**A recording commits the organization id of the account it was made with**: it is in every organization path (`/organizations/7008/…` for the owner's sandbox account), in the `href` and `Link` of every list, and the resource carries the account's `application_id` and `owner_id`. None of them is a secret, and none can be scrubbed without breaking the replay. The token, the sender and the receiver are scrubbed.

A replay reads the organization id, the locker and the two references back from the cassette (`recordedConformance`), so nothing in the test needs editing after a recording. References are scrubbed to `scrubbed-N`; ShipX's answers carry the same placeholder, which is why a replay sends the placeholder as its reference.

Expect these differences from the hand-written cassettes, and fix the connector or this file where they contradict it: ids, tracking number and timestamps; the organization id in every path; how many label attempts the purchase took, and whether the status seen between them is `offer_selected`; the label's content type; whether a shipment past `confirmed` still carries `offers` and `transactions`.

The scenario cassettes (`src/scenarios.test.ts`) are skipped when recording and are never overwritten. Those that could be recorded once someone writes the steps: lost answer, list lag, unknown target point, label too early, cancel in time and too late, the failed payment (an account without funds). The rest cannot: statuses after `confirmed`, unavailable offers on demand, an inconsistent listing, a skewed clock, a redirect, and error statuses.
