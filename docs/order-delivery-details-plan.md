# Order delivery details — reviewed backend plan

Status: planning only; no application or database changes.
Reviewed: 2026-11-02. This version replaces the first plan.
Branch in both repositories: `feat/order-delivery-details`.
Companion: [frontend plan](../../megadie-frontend-v2/docs/order-delivery-details-plan.md).

## 1. Goal and scope

Keep three clear owners: a store has a pickup location, a customer has usual delivery details, and an order has its own saved destination. Courier and Prepare & Deliver use the same order destination. Editing an order never updates the customer's account or other orders. Editing customer defaults affects future orders, not saved destinations.

This is an address-and-copy feature. It does not change quoting, pricing, invoices, payments, reservations, order statuses, or stock deduction. Copying is read-only. No address book, driver management, route planning, geocoding, map SDK, or new dependency is required.

## 2. Review corrections and simplifications

| First plan | Reviewed decision | Reason |
| --- | --- | --- |
| New nested customer default plus mirrored legacy fields | Keep existing customer address fields; add only two optional contact overrides | One stored value per field; no migration or synchronization layer |
| Separate StoreLocation collection and CRUD | Configure the confirmed store inside existing SiteSettings | Existing settings model, controller, and routes are sufficient |
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

## 5. Current store AE1: reuse SiteSettings

AE1 identifies the first UAE store; the user has confirmed there is currently only one store in the UAE and AE2 is an unused code. The previous assumption that AE1 and AE2 are two existing physical stores is withdrawn. Configure AE1 only. Do not create an AE2 location, duplicate AE1's location under AE2, or rename/delete the unused inventory code as part of this feature.

The existing singleton `SiteSettings` record can hold `storeLocations.AE1`, containing `name`, `address`, `googleMapsUrl`, `phoneNumbers` (up to two), and optional `notes`. Keep the existing store code and show a readable label such as Megadie UAE (AE1). Other codes can receive location details later when their actual physical meaning is confirmed; no generic store-management feature is needed now.

Expose two admin-only operations in the existing settings controller/router: read configured locations, and save a confirmed existing store code. Start with AE1 only. Update only `storeLocations.<code>` so a store save cannot replace other settings or the maintenance notice. Keep the public maintenance-notice response explicitly allowlisted; store details are not public. No separate collection, index, generic warehouse CRUD, store deletion, or settings version protocol is needed.

For a usable pickup, an address **or** map is sufficient. Pickup phone and notes are useful but optional. Missing configuration produces a clear draft warning, never a guessed location.

AE1's actual address and map link still need confirmation. Confirm whether the current hard-coded external-courier pickup point is AE1 before reusing it; preserve the current configuration until then. An allocation using an unconfigured code produces a location warning, not an assumed extra pickup or an automatic alias to AE1.

## 6. Small API additions

Use the existing response envelope and authorization conventions.

| API | Change |
| --- | --- |
| Existing GET/PUT `/api/users/account/profile` | Add the two optional delivery contact overrides; retain current fields and account semantics |
| Existing GET/PUT `/api/users/:id` (admin) | Same additional fields on user details/editing |
| GET `/api/site-settings/store-locations` (admin) | Return configured store locations; initially AE1 |
| PUT `/api/site-settings/store-locations/:code` (admin) | Save a confirmed store code; initially AE1; do not invent new inventory codes |
| Existing GET `/api/orders/:id` | Add `resolvedDelivery` using current owner/admin access rules |
| PUT `/api/orders/:id/delivery-details` (admin) | Body `{ deliveryDetails, expectedRevision }`; update this order only; return saved details and revision |
| GET `/api/orders/:id/fulfillment-sheet` (admin) | One fresh staff-sheet read; no state changes |

Do not load fulfillment data for order-list rows or add address-specific work to every list query. Preserve owner pricing sanitization and existing access checks. General order updates must not accept delivery details through an unguarded second path.

For newly edited values, trim strings, enforce reasonable length/type limits, accept international phone text, and require a valid HTTPS URL when a map is supplied. Do not dereference short links or enforce a Google domain list. A complete delivery copy requires a contact name, primary phone, and address or map. Incomplete data can be saved. Validate edited data without making an unrelated account save or order conversion fail because of legacy delivery formatting.

## 7. Prepare & Deliver read and text

Read the selected order, its relevant allocations/slots, and the relevant configured pickup location using selected fields and bounded queries. Return 409 for Cancelled/Delivered orders instead of generating new preparation instructions, including when the list row was stale. Use order SKU/product-name snapshots for item identification; a missing old name can fall back to SKU. No product-by-product lookup or new selling-unit system is needed. Use neutral units.

Return a small allowlisted response containing order number/status, generated time, carton tag, resolved destination, pickup groups, per-product ordered/allocated quantities, and two arrays: `problems` (makes the sheet a draft) and `notices` (advisory). Keep business checks in the backend and text formatting in a pure frontend helper. This is not a new fulfillment state machine.

- For the current AE1 operation, show one pickup heading followed by its naturally sorted slots (A2 before A10) and one final per-SKU packing check. Group by actual store code if additional physical locations are confirmed later; never fabricate a second pickup from a code alone. Aggregate duplicate order items by product id before comparing quantities.
- Follow existing allocation rules: Reserved and legacy missing-status rows are reservations; Deducted rows are inventory history; Cancelled rows are excluded. Flag missing slots, unknown stores, foreign-product rows, invalid quantities, quantity mismatches, or mixed reserved/deducted state. Do not hide excess rows or present them as approved picking instructions.
- Preserve the actual workflow: **Shipping/reservations → Delivered → stock finalization**. An inventory deduction does not itself prove physical collection. Retain the existing check-before-picking-again warning rather than inventing automatic picked/packed status.
- Complete Shipping orders get a normal sheet. Processing/unconfirmed/incomplete/inconsistent orders get a clearly labeled preparation draft / HOLD with the specific problems. This does not block existing order-status APIs or create new readiness requirements there.
- Do not offer a new actionable staff sheet for Cancelled or Delivered orders. Keep existing order viewing; no separate completed-reference feature is needed. Finalized allocations can expire after 60 days under the existing TTL, so historical slot reconstruction is outside scope.
- Recipient contact, destination, and delivery notes belong in the staff sheet. Prices, payment/invoice data, account email, internal order notes, and staff identities do not. Courier retains its separate commercial instructions/content but uses the same resolved destination.

Ordinary reads are not an atomic cross-collection snapshot. The sheet is informational data fetched for the selected click; changes made during/after the read can make it stale. Show the generation time in any preview and allow retry/refresh. Keep allocation writes/delivery/finalization checks authoritative in their existing transactions. Do not add read transactions, polling, or compare-and-confirm logic for clipboard text.

## 8. Implementation order and verification

1. Implement the small default/resolution helper, two optional User fields, and saved order value/revision. Wire existing user APIs and order creation; test default/order isolation.
2. Add guarded order-only delivery editing and the customer-reassignment safeguard. Switch Courier from editing User to editing the order.
3. Extend existing settings with AE1's pickup details and a small editor; leave the unused AE2 code unconfigured.
4. Add the combined sheet read and evolve the unfinished pick-list formatter/button into Prepare & Deliver.
5. Run focused integration checks, frontend lint/build, and relevant existing order/catalog regression tests before coordinated review/release.

Meaningful checks: profile changes do not alter saved orders; two orders can differ; order contact edits preserve account identity/defaults; saved blanks stay blank; legacy suggestions require an explicit save; stale writes and delivered/cancelled edits fail; customer reassignment cannot leave the wrong destination; AE1 has one pickup heading with correct slot quantities; unknown/unconfigured codes produce warnings rather than guessed routes; new endpoints enforce admin/owner rules; copying performs no stock/status/address writes; saving a store preserves other settings; public notice output excludes store data.

Use pure Node tests for helpers/formatters and a disposable test database for persistence and authorization. The local backend is configured for `production-db`; do not use it for mutation tests or automatic backfills.

## 9. Release boundaries

Deploy additive backend changes first, then the frontend in the same coordinated release. Avoid order creation and courier delivery edits between the two deployments: the old frontend still edits User while the new backend captures order destinations. If those actions did occur in the gap, review the affected active orders' destinations before using the new copy actions. This short release coordination avoids introducing a permanent feature-flag or dual-write mechanism. Enter AE1's real pickup location before relying on final staff sheets. An unexpected AE2 allocation requires data review rather than a second pickup, since AE2 is unused. Review active legacy destinations as needed; do not bulk rewrite completed orders.

Keep both repositories on `feat/order-delivery-details`. Preserve the local pick-list work and exclude unrelated inventory operation scripts from feature commits. This review updates plans only; it does not implement, push, deploy, or migrate anything.
