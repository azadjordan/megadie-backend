# Order delivery details — backend and shared contract

Status: proposed implementation plan; no schema, API, or database changes applied.
Date: 2026-11-02.
Branch in both repositories: `feat/order-delivery-details`.
Backend starting commit: `93c2970` (`main`, synchronized with GitHub when branching).
Frontend starting commit: `d1f574e`.
Frontend companion: `../../megadie-frontend-v2/docs/order-delivery-details-plan.md`.

## 1. Outcome

An administrator can give one person a clear **Prepare & Deliver** sheet: collect the reserved items from the correct physical stores, check the packed quantities, and deliver to the recipient saved for that order. The existing **Courier** action stays available for an external delivery company. Both actions use the same order destination.

The data belongs in three places:

| Owner | Meaning | When it changes |
| --- | --- | --- |
| Store location | Where AE1 or AE2 physically is | An administrator edits that store |
| Customer default | The customer's usual delivery contact and destination | Customer or administrator edits the default |
| Order destination | Delivery details chosen for one order | Administrator explicitly edits that order |

Changing a customer default must not change existing order destinations. Editing one order must not change the customer's account or other orders. Copying a sheet must not reserve, deduct, deliver, or otherwise change the order.

## 2. Current behavior and affected code

- `models/userModel.js`: flat `phoneNumber`, `secondaryPhoneNumber`, `address`, `deliveryGoogleMapsUrl`, and `deliveryNotes`. `name` doubles as the recipient name. The account `phoneNumber` has a unique index.
- `models/orderModel.js`: references `user`, with no saved delivery destination.
- `controllers/orderController.js`: single/admin order reads populate the customer's current profile; `createOrderFromQuote` creates orders inside an existing transaction. General order updates can change the customer when no invoice exists.
- `controllers/userController.js` and `routes/userRoutes.js`: profile and administrator user editing already exist.
- `models/slotModel.js`: slots reference the stable store codes `AE1` and `AE2`. There is no physical-location directory. `StoreSnapshot` is an inventory summary, not an address record.
- `controllers/orderAllocationController.js`: allocation reads populate products and slots; the current response also includes internal staff fields that do not belong in shared sheets.
- Frontend courier copying currently saves edited delivery fields back to the **User**. The unfinished local worker pick-list prototype reads an order and its allocations separately.

## 3. Scope and boundaries

Implement the three data owners, their editing flows, and the two copy actions. Keep existing inventory store codes, slots, allocations, quote pricing, invoice addresses, payments, and stock workflows intact except where their integration with the new destination must be explicit.

One customer default and one destination per order are sufficient for this version. Multiple address books, coordinates, geocoding, route optimization, driver accounts, and delivery tracking are outside this feature. Do not infer that allocated or deducted stock has physically been packed.

## 4. Data design

### Shared delivery-details value

Use the same field names for the customer default and the order copy:

```json
{
  "contactName": "Recipient or company contact",
  "phoneNumber": "+971...",
  "secondaryPhoneNumber": "",
  "address": "Building, street, area, city, and useful landmarks",
  "googleMapsUrl": "https://maps.app.goo.gl/...",
  "notes": "Entrance instructions or receiving hours"
}
```

These are trimmed strings, not foreign-key references to a mutable address. Explicitly clearing a field must keep it cleared; do not fill individual empty fields from another source after a value has been saved.

Allow incomplete defaults and order destinations to be saved. A complete destination for final sharing needs a contact name, primary delivery phone, and **address or Google Maps link**. A map is encouraged but not mandatory when the written address is sufficient. Validate provided phone values without assuming every recipient has a UAE number. Accept ordinary Google Maps links, including existing short links; parse URLs and require HTTPS and an approved Google Maps host/path. Do not resolve short links or call a maps service on page loads.

Set finite lengths in the shared validation helper: name 200, phones 50 each, address 1000, map URL 2048, notes 1000 characters. Reject malformed provided values with field errors, not silently truncated text. Preserve international characters and readable addresses.

### Customer: `User.defaultDeliveryDetails`

- Add an optional embedded value with the shape above; absence means a legacy customer, not a saved blank default.
- Keep account `name`, `email`, and unique `phoneNumber` as account identity/contact fields. A delivery phone is not unique and may belong to a receptionist, branch, or another recipient.
- When the new object is absent, derive a suggested default from the old fields: `name` → `contactName`, account phone → delivery phone, old address/secondary phone/maps/notes → matching delivery fields.
- Once the new object exists, use the whole saved object. Account name/phone changes do not silently rewrite it.
- No bulk user rewrite is necessary. The new object is persisted when the default is explicitly saved; new orders may copy the derived legacy default.

### Physical store: `StoreLocation`

Create a small directory with `code` (unique, fixed `AE1`/`AE2`), `name`, `address`, `googleMapsUrl`, `phoneNumbers` (at most two), optional `contactName`/`notes`, and timestamps. Store codes are immutable. Two short editing forms are enough; no generic warehouse-management feature is required.

Slots continue storing their existing code. A store's latest physical details are resolved from that code when a sheet is requested. Do not copy an address onto every slot or reuse `StoreSnapshot`. An absent/incomplete store record produces a visible missing-pickup warning, not a guessed address.

AE1 and AE2 are confirmed to be separate physical locations. Their actual addresses, maps, and phones still need to be entered/confirmed. The existing hard-coded courier pickup pin has **not** been identified as either location. Keep that courier handoff configuration until its meaning is confirmed; do not assign it to both stores. If it is confirmed to be AE1/AE2, the courier action can reference that directory entry. Otherwise it remains the separately named courier handoff point for this release.

### Order: saved `deliveryDetails`

Add an optional embedded `deliveryDetails` value and `deliveryDetailsMeta`:

```json
{
  "source": "customer_default",
  "revision": 1,
  "capturedAt": "server timestamp of first capture",
  "updatedAt": "server timestamp of latest edit",
  "updatedBy": "administrator id"
}
```

Source values: `customer_default`, `order_override`, `legacy_confirmed`. Metadata is server-controlled. Old orders without a saved object have revision `0`. New orders receive a normalized copy of the resolved customer default inside the order-creation transaction, even if some details are missing. Missing delivery information does not prevent creating the order from a confirmed quote.

The snapshot freezes the selected values against later profile edits; it is still explicitly editable while the order is `Processing` or `Shipping`. Delivered/cancelled orders are read-only through this feature. Each successful change increments the revision. A repeated identical save need not increment it; first capture/legacy confirmation must persist it.

If the existing general order-update flow changes `user`, replace the destination from the new customer's default in the same protected update and increment its revision. Return a visible destination-reset result. Never retain the previous customer's destination or silently overwrite a concurrent destination edit. Existing invoice/customer-change restrictions still apply.

## 5. Resolution and older orders

Implement one backend resolver used by both order reads and the fulfillment-sheet endpoint:

1. Saved `order.deliveryDetails` exists: return it as a whole, independent of current User data.
2. Legacy active order without saved details: return the current customer default as a **suggestion**, with `requiresConfirmation: true` and `source: legacy_customer_profile`. Reading does not write a snapshot.
3. Legacy delivered/cancelled order without saved details: return historical destination unavailable. Do not substitute today's profile as a historical address.

Expose this read contract as `resolvedDelivery`:

```json
{
  "details": { "contactName": "...", "phoneNumber": "...", "secondaryPhoneNumber": "", "address": "...", "googleMapsUrl": "", "notes": "" },
  "source": "order_override",
  "revision": 2,
  "requiresConfirmation": false,
  "missingFields": [],
  "updatedAt": "server timestamp or null"
}
```

An administrator reviews and saves an active legacy order before final delivery copying. A clearly marked preparation draft may be copied earlier. Never backfill completed orders with current profile data and call it their original destination. Do not create snapshots from GET requests or clipboard actions.

## 6. API contract

Follow the existing `{ success, message, data }` response envelope except where existing endpoints already return another shape. Share validation/resolution code; do not maintain two different definitions of a complete destination.

| Route | Access | Behavior |
| --- | --- | --- |
| Existing `GET /api/users/profile`, `GET /api/users/:id` | Self / admin | Return resolved `defaultDeliveryDetails` and indicate `saved_default` or `legacy_profile` |
| Existing `PUT /api/users/profile`, `PUT /api/users/:id` | Self / admin | Accept `defaultDeliveryDetails`; when present it replaces that normalized value; omission leaves it unchanged |
| `GET /api/store-locations` | Admin | Return AE1/AE2 configuration and completeness; two records maximum |
| `PUT /api/store-locations/:code` | Admin | Upsert the fixed-code location; validate provided fields, permit incomplete setup; protect stale edits using expected `updatedAt` |
| Existing order detail/admin reads | Existing owner/admin rules | Include saved details and `resolvedDelivery`; customer responses omit internal editor metadata and stock locations |
| `PUT /api/orders/:id/delivery-details` | Admin | Save this order only; body `{ deliveryDetails, expectedRevision }`; server determines source and timestamps |
| `GET /api/orders/:id/fulfillment-sheet` | Admin | Fresh, purpose-built DTO for Prepare & Deliver; no writes |

Require `expectedRevision` as a nonnegative integer in every destination-update request. Use a conditional database update: that revision, active status, and the customer loaded for the update must still match. A missing revision in an old stored order is treated as `0`; an omitted request revision is invalid. Return `409` with a refresh/review message if the record changed; return `400` for invalid values, `404` for unknown orders/codes, and existing auth errors for unauthorized requests. The client must not force an overwrite after a conflict.

### Compatibility during deployment

- Keep legacy User fields and response aliases during this feature. Audit reads/writes in registration, profile, admin editing, and any document generation before changing their behavior.
- New nested delivery writes mirror delivery-only aliases (`address`, `secondaryPhoneNumber`, `deliveryGoogleMapsUrl`, `deliveryNotes`) for older readers. They **never** overwrite account name or account phone.
- Older clients sending a subset of those delivery-only aliases patch that subset of the normalized default, initializing from the legacy profile first if needed. Unsubmitted fields are preserved.
- Old account name/phone writes keep their account semantics. Once a saved default exists, they do not automatically change its independent contact. The old courier UI still has its current account-editing behavior until the new frontend deploys; backend compatibility alone does not fix that UI.
- Preserve pricing sanitization and ownership checks when extending order responses. Do not let new customer API fields expose internal notes/editor identities or store details.

## 7. Prepare & Deliver read model and rules

Use one request when the administrator opens/copies the sheet, rather than separate per-row order/allocation/store requests. Read the order, relevant allocations/slots, referenced stores, and any needed product labels in bounded batches, with a read-only snapshot transaction for a consistent view across these collections. Existing order transactions already require transaction support. Return a generation timestamp; a copied message represents that moment and is not a live reservation or delivery guarantee.

Build an explicit DTO with:

- order id, number, status, stock-finalized state, generation time, and carton label;
- the shared `resolvedDelivery`;
- `pickups`: only stores referenced by eligible allocations, grouped by store then slot; each store includes its own address, map, contacts, and allocation lines;
- `items`: product id, immutable order SKU/name where available, size/variant label where available, ordered quantity, active reserved quantity, deducted quantity, and unresolved balance;
- structured warnings and a final-sheet/draft/reference state.

Use order item snapshots as the expected packing list; enrich readable variant labels only when necessary. Product schema currently has no explicit selling-unit field, so use neutral `units` unless an existing product-type rule can reliably supply the correct unit. Do not label every product as rolls. Naturally sort slots (A2 before A10). Include each actual pickup only once.

Only active allocations count: `Reserved`, `Deducted`, and legacy missing-status allocations treated according to existing stock rules; cancelled allocations do not count. Keep deducted quantities separate from quantities still needing collection. Flag orphaned allocations, unknown stores/slots, products outside the order, fractional/invalid quantities, under-allocation, over-allocation, and mixed states. Never silently present excess stock as an instruction to pick it.

| Condition | Output behavior |
| --- | --- |
| Active order, destination confirmed/complete, pickups complete, quantities reconcile | Final Prepare & Deliver sheet |
| Missing destination/pickup details, unconfirmed legacy destination, or allocation discrepancy | Clearly headed preparation draft / HOLD; final copy unavailable; identify what needs fixing |
| Already deducted/finalized stock | Prominent warning to check packed goods; deducted lines are reference quantities, not new pick instructions |
| Delivered | Read-only completed reference; no fresh preparation/delivery instruction |
| Cancelled | No actionable copy; show cancellation explanation |

The staff formatter receives only this DTO. Exclude prices, totals, invoices/payments, internal notes, staff identities, and unrelated account fields. Delivery contact data is intentionally included for this authorized role. Courier keeps its existing financial/instruction content and single handoff pickup; reuse destination data/validation, not the entire courier template for staff.

## 8. Implementation sequence

1. **Shared contract and tests:** normalization, completeness, URL rules, whole-value resolution, legacy behavior, revision-conflict fixtures.
2. **Models and defaults:** add embedded customer/order values and StoreLocation; extend profile/admin user APIs and compatibility adapters. No destructive migration.
3. **Order integration:** capture defaults in quote-to-order creation, add order-only update endpoint, handle customer reassignment and owner/admin projections.
4. **Locations and sheet:** fixed-code location API, fresh batched fulfillment read, readiness/warning rules, explicit DTO.
5. **Frontend integration:** follow the companion plan; replace the prototype's two requests, update courier editing semantics, and use both copy actions to verify the shared destination.
6. **End-to-end review and release:** validate customer/default/order isolation and both store pickups, review final diff, then commit/push feature work and merge/deploy only in the agreed release step.

Each stage should remain reviewable. Include only feature changes; the unrelated untracked inventory operation scripts are excluded.

## 9. Verification and acceptance

Use pure Node tests for normalization, resolution, DTO/quantity rules, and field allowlists. Use a disposable MongoDB test database for persistence, authorization, conditional updates, and transaction reads. The current development backend points to `production-db`; do not use it for mutation tests or migrations.

- A new order copies the default at creation; later profile changes leave it unchanged.
- Changing delivery phone/name does not change account phone/name or its uniqueness rules; two customers may share a delivery contact.
- Two orders for one customer can have different destinations; editing one affects neither the other nor the default.
- Saved blank fields stay blank; partial form updates do not erase unsubmitted values.
- Legacy active orders require explicit confirmation; legacy completed orders do not get fabricated historical destinations.
- Customer reassignment cannot retain the old destination, bypass invoice restrictions, or overwrite a concurrent edit.
- Two editors racing to save yield one success and one conflict; delivered/cancelled transitions also prevent stale destination updates.
- Ordinary users cannot edit order destinations/manage locations/read staff sheets; owners only see permitted order fields.
- AE1-only, AE2-only, and multi-store orders show exactly the relevant physical pickups and correctly sorted slots.
- Complete/partial/excess/orphaned/cancelled/deducted allocations produce the specified quantities and warnings.
- Copy/read endpoints perform no writes and do not change availability, allocation status, order status, or payment state.
- External Courier and Prepare & Deliver show identical recipient details for the same saved order, with their separate content rules.
- Existing catalog/availability and affected order-creation tests continue to pass; run frontend lint/build and the targeted integration flow once implemented.

## 10. Rollout and remaining inputs

Deploy the additive backend first, then the frontend. Enter and verify actual AE1/AE2 location data before relying on final staff sheets; incomplete configuration remains visibly a draft. Review and capture active legacy order destinations as staff use them. No mass backfill of historical orders or legacy-field deletion is part of this release.

Keep both repositories on `feat/order-delivery-details` during implementation and create a coordinated review for each. The plans are local at this stage; there is no deployment, database migration, or new GitHub push from planning.

Needed before production use: AE1/AE2 written addresses, map links, contact phones, and confirmation of what the existing external-courier pickup point represents. These inputs do not block planning or implementing the address forms and missing-data behavior.
