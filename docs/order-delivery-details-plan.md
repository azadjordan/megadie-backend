# Order delivery details — reviewed backend plan

Status: implemented and locally verified; merge/push to main authorized. No data migration is required.
Reviewed: 2026-11-02. This version replaces the first plan.
Branch in both repositories: `feat/order-delivery-details`.
Companion: [frontend plan](../../megadie-frontend-v2/docs/order-delivery-details-plan.md).

## 1. Goal and scope

Keep two delivery-data owners: a customer has usual delivery details, and an order has its own saved destination. Courier and Prepare & Deliver use the same order destination. Editing an order never updates the customer's account or other orders. Editing customer defaults affects future orders, not saved destinations. Internal staff already know the single AE1 store; its address/contact details do not belong in this staff message or require new storage in this feature.

This is an address-and-copy feature. It does not change quoting, pricing, invoices, payments, reservations, order statuses, or stock deduction. Copying is read-only. No address book, driver management, route planning, geocoding, map SDK, or new dependency is required.

## 2. Review corrections and simplifications

| First plan | Reviewed decision | Reason |
| --- | --- | --- |
| New nested customer default plus mirrored legacy fields | Keep existing customer address fields; add only two optional contact overrides | One stored value per field; no migration or synchronization layer |
| StoreLocation collection or SiteSettings store editor | Omit store-location storage, APIs, and UI from this feature | Staff use the one known AE1 store; slot labels are sufficient |
| Source enums, capture/edit timestamps, editor identity | Saved order value plus one delivery revision | No current feature needs a separate address audit system |
| Read-only snapshot transaction for every sheet | Ordinary bounded database reads | Copying is an informational read, not a stock operation |
| Preview, fetch again on Copy, compare responses, confirm changes | One fresh request per normal copy click | Preserve the existing simple copying interaction |
| New full customer profile delivery interface | Extend existing admin fields; retain the current customer profile form | Avoid a separate profile redesign |
| Google host allowlist and detailed phone parsing | Length/type checks, a valid HTTPS map link, and ordinary international phone text | No provider-specific URL parser or phone normalization project |

The earlier profile path was wrong: the existing route is **`/api/users/account/profile`**, not `/api/users/profile`.

## 3. Customer defaults: retain current storage

The current User fields already describe a default destination: `address`, `secondaryPhoneNumber`, `deliveryGoogleMapsUrl`, and `deliveryNotes`. Keep their names and existing API behavior. Add optional strings `deliveryContactName` and `deliveryPhoneNumber` so a receptionist/recipient can differ from the account holder.

A small backend helper produces this common value:

```text
contactName          = nonblank deliveryContactName, otherwise account name
phoneNumber          = nonblank deliveryPhoneNumber, otherwise account phoneNumber
secondaryPhoneNumber = existing secondaryPhoneNumber
address              = existing address
googleMapsUrl        = existing deliveryGoogleMapsUrl
notes                = existing deliveryNotes
```

The two optional overrides are explicitly labeled that way in the UI. Clearing an override means use the account contact for future orders. Clearing an address/map/notes clears that field. The account's unique phone constraint stays as it is; delivery phone overrides are not unique. Neither an order edit nor an override edit writes to the account name/phone.

Extend existing profile/admin user allowlists and detail responses for those two fields. Omitted update fields stay unchanged. Do not introduce a nested customer object, aliases, dual writes, new user-list queries, or a bulk customer migration. Account name/phone changes affect future default resolution only when no contact override is set.

## 4. Order destination: the necessary new storage

Add optional embedded `Order.deliveryDetails`, with these six string fields:

```text
contactName, phoneNumber, secondaryPhoneNumber,
address, googleMapsUrl, notes
```

Add `deliveryRevision`, a nonnegative integer. Existing orders without the field read as revision 0. New order destinations start at 1; every explicit destination save increments it. No saved source enum, separate timestamps, or editor fields are needed for this feature.

- In the existing quote-to-order transaction, read the customer's defaults using the same session and save a copy on the new order. Incomplete details must not block order creation.
- The saved object is authoritative as a whole. A deliberately empty order field must not be filled from today's profile. Its presence, even when incomplete, distinguishes a saved destination from an older order without one.
- Administrators can edit destinations while Processing or Shipping. Delivered/cancelled orders are read-only through this endpoint.
- Save the destination and increment its revision in one conditional update, checking expected revision and active status. Require `expectedRevision` in the request. Return 409 on a stale edit and retain the administrator's entered text in the UI.
- The existing API permits changing an order's customer when no invoice exists. If that happens, copy the new customer's default and increment the delivery revision in the same protected write. Never retain the previous customer's destination. Preserve existing invoice restrictions and guard against concurrent delivery edits. Do not add a new customer-reassignment interface or refactor unrelated order updates.

### Older orders

Use one backend resolver for order details and staff-sheet reads:

1. Saved order value exists: return it without consulting profile fields for replacements.
2. Older Processing/Shipping order without a saved value: return the current customer default as a suggestion. The administrator reviews and explicitly saves it before a final delivery copy.
3. Older Delivered/Cancelled order without a saved value: historical destination is unavailable. Do not invent it from today's profile.

Return a small `resolvedDelivery` view: `details` (or null), `savedToOrder`, `revision`, and `missingFields`. No second persisted default or historical backfill is required. GET requests never save an address. A button labeled Save & Copy may perform an explicit save followed by a read/copy; a plain Copy action does not save anything.

## 5. Single-store scope: no pickup-address feature

AE1 identifies the first UAE store; the user has confirmed there is currently only one UAE store and AE2 is unused. Prepare & Deliver is for internal staff who collect from that known store. Omit the store name/address/map/phone block and retain full slot labels such as A2-AE1, item identification, and quantities.

Do not add a StoreLocation model, SiteSettings fields, store-location endpoints, an inventory settings form, or pickup-completeness checks. Do not fetch settings when generating the staff sheet. No store-address confirmation is needed to implement or use this internal message.

Keep existing slot/store codes intact, including the unused AE2 code. An unexpected AE2 allocation is a data issue to review, not an instruction to visit a second store or an automatic alias to AE1.

The external Courier message still needs its existing pickup address/map/phones. Preserve `courierPickupConfig` and its message content. Share the order's customer destination between the two actions without moving or deleting courier pickup details. A new physical store or a need to send the staff sheet to outside collectors would justify revisiting pickup addresses later.

## 6. Small API additions

Use the existing response envelope and authorization conventions.

| API | Change |
| --- | --- |
| Existing GET/PUT `/api/users/account/profile` | Add the two optional delivery contact overrides; retain current fields and account semantics |
| Existing GET/PUT `/api/users/:id` (admin) | Same additional fields on user details/editing |
| Existing GET `/api/orders/:id` | Add `resolvedDelivery` using current owner/admin access rules |
| PUT `/api/orders/:id/delivery-details` (admin) | Body `{ deliveryDetails, expectedRevision }`; update this order only; return saved details and revision |
| GET `/api/orders/:id/fulfillment-sheet` (admin) | One fresh staff-sheet read; no state changes |

Do not load fulfillment data for order-list rows or add address-specific work to every list query. Preserve owner pricing sanitization and existing access checks. General order updates must not accept delivery details through an unguarded second path.

For newly edited values, trim strings, enforce reasonable length/type limits, accept international phone text, and require a valid HTTPS URL when a map is supplied. Do not dereference short links or enforce a Google domain list. A complete Courier copy requires a contact name, primary phone, and address or map. Prepare & Deliver requires only an address or map; its completeness view filters out contact-only missing fields. Incomplete data can be saved. Validate edited data without making an unrelated account save or order conversion fail because of legacy delivery formatting.

## 7. Prepare & Deliver read and text

Read the selected order and its relevant allocations/slots using selected fields and bounded queries. No store-settings read is needed. Return 409 for Cancelled/Delivered orders instead of generating new preparation instructions, including when the list row was stale. Use order SKU snapshots for item identification. Product names/descriptions are not selected for this endpoint and are omitted from its item/pick DTOs. No product-by-product lookup or new selling-unit system is needed. Use neutral units.

Return a small allowlisted response containing order number/status, generated time, carton tag, resolved destination, slot pick lines, per-product ordered/allocated quantities, and two arrays: `problems` (makes the sheet a draft) and `notices` (advisory). Keep business checks in the backend and text formatting in a pure frontend helper. This is not a new fulfillment state machine.

- Return SKU/slot/quantity lines for SKU-first display: the formatter groups all slots under each SKU, naturally sorts them, and assigns matching item numbers in PICK and PACK & CHECK. PICK has no per-SKU subtotal. Pack & Check lists each SKU with its ordered total. Show distinct-item count and ordered-unit count at the top and repeat the summary below packing totals. Omit product names/descriptions and store location/contact information. Continue aggregating duplicate order items by product id before validating allocation quantities.
- Follow existing allocation rules: Reserved and legacy missing-status rows are reservations; Deducted rows are inventory history; Cancelled rows are excluded. Flag missing slots, unknown stores, foreign-product rows, invalid quantities, quantity mismatches, or mixed reserved/deducted state. Do not hide excess rows or present them as approved picking instructions.
- Preserve the actual workflow: **Shipping/reservations → Delivered → stock finalization**. An inventory deduction does not itself prove physical collection. Retain the existing check-before-picking-again warning rather than inventing automatic picked/packed status.
- Complete Shipping orders get a normal sheet. Processing/unconfirmed/incomplete/inconsistent orders get a clearly labeled preparation draft / HOLD with the specific problems. This does not block existing order-status APIs or create new readiness requirements there.
- Do not offer a new actionable staff sheet for Cancelled or Delivered orders. Keep existing order viewing; no separate completed-reference feature is needed. Finalized allocations can expire after 60 days under the existing TTL, so historical slot reconstruction is outside scope.
- Only the delivery address and Google Maps link belong in the staff message. Names, phones, contact information, notes, product names/descriptions, prices, payment/invoice data, and staff identities are excluded. The shared destination value remains available to the admin order editor so saving it does not erase Courier contacts; Courier keeps its own contact/commercial content requirements.

Ordinary reads are not an atomic cross-collection snapshot. The sheet is informational data fetched for the selected click; changes made during/after the read can make it stale. Show the generation time in any preview and allow retry/refresh. Keep allocation writes/delivery/finalization checks authoritative in their existing transactions. Do not add read transactions, polling, or compare-and-confirm logic for clipboard text.

### Carton label

After the title and order line, `_Carton Tag:_` labels the bold compact identifier: customer initials, uppercase and without dots/spaces, followed by a hyphen and the full final segment of the order number. Example: `Carton Tag: ABC-023AD`. Preserve the whole suffix, including six-character suffixes used by generated orders. Use `ORD` if the customer name is unavailable. Do not repeat the label lower in the message.

## 8. Implementation order and verification

1. Implement the small default/resolution helper, two optional User fields, and saved order value/revision. Wire existing user APIs and order creation; test default/order isolation.
2. Add guarded order-only delivery editing and the customer-reassignment safeguard. Switch Courier from editing User to editing the order.
3. Add the combined order/allocation sheet read and evolve the unfinished pick-list formatter/button into Prepare & Deliver, omitting store addresses.
4. Run focused integration checks, frontend lint/build, and relevant existing order/catalog regression tests before coordinated review/release.

Meaningful checks: profile changes do not alter saved orders; two orders can differ; order contact edits preserve account identity/defaults; saved blanks stay blank; legacy suggestions require an explicit save; stale writes and delivered/cancelled edits fail; customer reassignment cannot leave the wrong destination; slot quantities/order and packing totals are correct; unknown/unused store codes produce warnings rather than guessed routes; new endpoints enforce admin/owner rules; copying performs no stock/status/address writes; the staff sheet includes customer destination details and excludes store contact/address information while Courier retains its pickup block.

Use pure Node tests for helpers/formatters and a disposable test database for persistence and authorization. The local backend is configured for `production-db`; do not use it for mutation tests or automatic backfills.

## 9. Release boundaries

Deploy additive backend changes first, then the frontend in the same coordinated release. Avoid order creation and courier delivery edits between the two deployments: the old frontend still edits User while the new backend captures order destinations. If those actions did occur in the gap, review the affected active orders' destinations before using the new copy actions. This short release coordination avoids introducing a permanent feature-flag or dual-write mechanism. No new store setup is required. An unexpected AE2 allocation requires data review, since AE2 is unused. Review active legacy destinations as needed; do not bulk rewrite completed orders.

Developed on `feat/order-delivery-details`; the user authorized merging and pushing the verified feature to `main` in both repositories. The pick-list prototype was evolved into this feature. Unrelated inventory operation scripts are excluded; no production data backfill or Render deployment was performed.

## 10. Verification record

- 21 backend/helper/integration/regression tests passed, including real order creation and persistence on an isolated local MongoDB replica set.
- 6 frontend formatter/delivery helper tests passed.
- 8 delivery browser tests passed against the dev server and the same 8 against the compiled production build.
- 19 catalog browser regression tests passed against the production build.
- Frontend full ESLint and production build passed. The existing large-bundle advisory remains unrelated to this feature.
- Mobile dialog checked visually and for overflow, keyboard focus handling, and navigation overlap; API/clipboard browser fixtures prevent production access and OS clipboard writes.

Run pure tests with `node --test tests/order-delivery.test.mjs`. The integration suite `tests/order-delivery.integration.mjs` needs an explicit `DELIVERY_TEST_URI` (or `DELIVERY_TEST_URI_FILE`) pointing to `127.0.0.1` and database `megadie_delivery_test`; it never reads `.env` and skips when no test URI is supplied. Browser tests: `node --test tests/order-delivery.browser.mjs`, optionally with `DELIVERY_TEST_ORIGIN` set to the local production-preview origin.

## 11. SKU-first message refinement

Prepare & Deliver now omits product names from item/pick DTOs and checks delivery location only. This is purpose-specific: `resolveOrderDelivery` and Courier still report missing contact name/phone. Tests cover a saved location with no contacts, legacy confirmation, and continued Courier validation. The frontend exact-message regression covers the requested carton-tag heading, two item/unit summaries, multi-slot SKU grouping, and address/map-only delivery output. No persisted order data or customer contact fields are removed by the presentation change.

Refinement verification: 22 backend/helper/API integration/regression tests, 8 frontend helper/formatter tests, and 9 delivery browser tests against each of the dev and production builds passed. Full frontend lint and production build passed. Database mutations used an isolated local replica set; browser API/clipboard interception prevented production access and OS clipboard writes.

## 12. Compact WhatsApp presentation

This follow-up changes the frontend text presentation only; the API payload is unchanged. The header uses `*PREPARE & DELIVER*`, `_Order:_`, and `_Carton Tag:_` with a bold compact identifier. One shared numbered SKU list drives PICK and PACK & CHECK. Slot quantities are indented arrow lines; per-SKU totals appear only as bold numbers on the packing checkbox lines. Delivery includes only italic-labeled address and map lines. The browser regression expectations cover the new exact header, grouping, numbering, and compact markup.

Compact-format verification: 10 frontend helper/formatter tests and 9 delivery browser tests on each of the dev and production builds passed, together with full frontend lint and build. Exact-output coverage includes the supplied WhatsApp template, matching item numbers above 99, multiple slots, no PICK subtotals, location-only delivery, and compact address lines. This presentation update changes no backend runtime logic.
