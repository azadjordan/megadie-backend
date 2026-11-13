# Worker packing: first implementation

Status: implemented and verified locally.

Current billing timing and stock-report follow-up:
[packing billing and stock review](packing-billing-and-stock-review.md).

Detailed screens, controls, and save/error behavior:
[worker packing UI plan](../../megadie-frontend-v2/docs/worker-packing-ui-plan.md).

## Outcome

An admin sends a fully reserved order to a worker. The worker opens it on a
phone, confirms actual collections, handles a shortage by changing to an
available location for the same product, and marks the order Packed after
checking the carton. Admin attention is needed for unresolved shortages and
stock discrepancies.

## Product scope

- Existing login, one worker permission, and two worker views: assigned orders
  and an order checklist.
- Three primary worker actions: Picked, Problem, and Packed. Picking starts
  implicitly with the first saved action.
- Small changes to the existing user editor, preparation dialog, admin order
  list, and order details.
- Existing reservation services and stock finalization remain the foundation.
- Stock reports stay with the order. Automatic location quarantine, a separate
  review dashboard, worker delivery confirmation, product substitutions,
  offline writes, scanning, and push notifications are outside this release.

## Admin flow

1. Enable Worker access on an existing account using the user editor. Only an
   admin can grant or remove it; public registration and profile updates cannot.
2. Reserve the order with the existing controls.
3. Open the existing preparation dialog, select the worker account and task,
   review the existing delivery instructions when relevant, and press Send to
   worker. Assignment and publication are one user action.
4. Publication checks fresh data: Shipping, not finalized or deducted, valid
   locations, exact reservations for every ordered product, enabled worker,
   preparation task, and required delivery destination. Rejection names the
   problems and does not publish a partial task.
5. The admin list and details show the assignee, picked progress, Packed, and
   a Needs help flag. Reports identify the product, original location,
   short quantity, reporter, and time. The admin uses existing stock tools to
   investigate and correct counts.

Old free-text assignments are display data, never authorization. Existing
orders are not automatically published or marked picked. For published orders,
the sharing action copies the authenticated worker-page link; it must not
create a second, independent set of picking instructions.

## Worker flow

The list contains only published orders currently assigned to this account.
Cards lead with client name and show order reference, carton tag, task, and
progress. Packed orders remain available in a compact completed group until
delivery, so a refresh does not make a successful completion look lost.

The checklist displays product name/SKU, the actual ordering unit, total needed,
and each reserved location with requested and already-picked quantities.
Server-saved progress survives refresh, sign-out, and another device.

- **Picked:** confirm collection from the displayed location. Default to all
  remaining units there; allow a smaller whole-number quantity. Save an absolute
  collected total, never a blind increment.
- **Problem:** one panel records how much was collected and what remains short.
  It shows available alternative locations for the same exact product in active
  AE1 slots. Selecting an alternative saves the replacement before the worker
  takes goods there; collection from the new location is confirmed afterward.
  No alternative produces a saved Needs help report. Other products remain
  usable, and the worker can return to the shortage later.
- **Packed:** one final confirmation after physical packing/checking. Require
  exact picked totals for all ordered products and no unresolved picking
  shortage. Keep this separate from the business order status.

Example: 10 reserved in A1, only 6 collected. Keep 6 reserved and picked in A1;
replace the remaining 4 with a reservation in B3, then confirm collecting those
4. If replacement fails, keep the reservation unchanged and retain the recorded
6 picked and the shortage report. Do not reset collected progress.

A successful replacement resolves the picking shortage. The original stock
discrepancy remains visible for admin review without blocking an otherwise
complete order. A worker's report never sets the inventory count to zero or
claims to be a full shelf count.

Original reports remain inside order details. The separate Stock check badge
and Mark reviewed lifecycle are deferred from this first release.

## Minimal data and access changes

- User: additive worker-access flag; preserve existing admin/customer roles.
- Order: worker account reference, sent timestamp, packed actor/timestamp,
  structured shortage reports, and compact packing activity history.
- Allocation: picked quantity, with picker/time metadata. Old allocations
  default to zero picked; a reservation does not prove physical collection.
- Activity records preserve who confirmed/returned stock or replaced a location,
  quantities, source/destination, and time. Keep report snapshots when an empty
  source allocation is removed. Reuse existing inventory movement logging for
  reservation release/reserve operations.

Use narrow packing APIs returning only the fields required for the assigned
task, with Cache-Control no-store. Validate the worker's current permission and
assignment on every read and write. A worker must not gain access to admin APIs,
customer pricing/catalog/finance APIs, or other orders through a direct URL.
Audit the existing customer guards as well as the new worker routes.

Extend the existing staff-session policy and warning/renewal mechanism to
workers. Worker accounts must not silently inherit the customer session policy.
Role changes and password resets revoke staff sessions. Admins retain access
to inspect and resolve packing tasks through the existing order page.

## Consistency rules

- Reuse the order/stock transaction guards. Each worker write checks current
  assignment, order eligibility, and the version the worker reviewed.
- Replacement is one transaction, including source reduction/removal, target
  reservation, availability checks against other orders, and audit movements.
  Never implement it as two independent release/reserve requests.
- Maintain 0 <= picked quantity <= reserved quantity. Replace only the unpicked
  remainder and never exceed the ordered product total. Already-picked target
  quantities remain intact when adding another reservation to that location.
- Protect picked quantities in existing manual/bulk reservation, cancellation,
  and deletion paths. A small return/correction action requires confirmation
  that the affected units are physically in their original location before
  reducing picked quantities. It does not change on-hand counts.
- Packed tasks lock picking/reservation changes. An admin can explicitly reopen
  packing, preserving collected quantities and recording the action.
- Reassignment preserves progress and immediately removes the old worker's
  access. The new worker sees what was already collected and a handover notice.
- Published tasks must be Packed before admin delivery/finalization. Legacy
  orders without worker publication keep their existing workflow.
- Picking retains the reservation and does not deduct on-hand stock. Existing
  Delivered + invoice finalization performs the deduction once.
- Guard physical shelf-count corrections for a product/location with picked,
  still-Reserved quantities, across all orders. The recorded on-hand balance
  still includes those collected units until finalization; replacing it with
  the shelf-only count could deduct them twice. In this release, reject that
  correction with the pending-picked quantity and explain that the relevant
  goods must first be finalized or physically returned/corrected. Enforce the
  guard on the server with the same transaction/conflict protection as picking,
  and show its reason in the existing count dialog. Keep reservation availability
  as on-hand minus all reservations; do not subtract picked reservations again.
- Disable competing actions while saving. A timeout triggers an authoritative
  refresh before another write; never present an uncertain result as success.
  Version checks and absolute quantity updates make duplicate attempts safe.
- Refresh visible tasks on focus and at a modest interval. Reports appear in
  the existing admin list; admins monitor Needs help there in this release.

## Implementation order

1. **Access and publication:** worker permission, staff sessions, assignment,
   sanitized reads, and Send to worker validation.
2. **Picking service:** actual collection tracking, shortage reports, atomic
   replacement, return/correction, Packed/reopen, and existing admin-path guards.
3. **Interface:** two phone-friendly worker views and the small admin additions.
   Build them on the completed service so the screens share the same rules.
4. **Verification and pilot:** automated checks below, then a supervised fresh
   order with one worker. Review full, partial, and unresolved-shortage examples
   before normal use. Do not enrol orders whose physical picking is uncertain.

These are implementation steps for one feature, not separate business stages
or additional approvals for the worker.

## Acceptance checks

- Authorized scope and sanitized responses; no self-granted access, customer
  prices, unassigned-order reads, or stale access after reassignment/revocation.
- Only complete eligible orders can be published; legacy orders stay usable.
- Normal packing, partial collections, split locations, existing target
  reservations, unresolved shortages, stock reports, and completion after a
  replacement all preserve the actual quantities and original report.
- Competing orders/admin edits cannot steal reserved stock; failed replacement
  rolls back all reservation changes while retaining earlier collection data.
- Duplicate taps, lost responses, refresh, multiple tabs/devices, and session
  expiry do not duplicate picking or erase progress.
- Reservation release, cancellation, deletion, reopen, return/correction, and
  reassignment cannot silently release physically collected goods.
- Published orders cannot bypass Packed; finalization deducts exactly once.
- Shelf-count correction cannot race with picking or deduct pending-picked
  units twice. Original stock reports remain available after a replacement or
  Packed without another review approval.
- Phone layout, readable units, clear save/error states, frontend lint/build,
  targeted integration tests, and relevant existing reservation/session tests.

Automated writes use an isolated local test database or mocked browser APIs,
never the configured production database.

## Implemented API and rollout

Admin item changes now use the dedicated flow documented in
[order item changes](order-item-changes.md). Existing general order updates keep
rejecting item edits; the dedicated operation checks stock, returns and order
eligibility atomically and retains the original shortage reports.

- `GET /api/packing/workers`: admin worker-account selector.
- `GET /api/packing/orders`: current assignments, paginated in groups of 50.
  `?view=board` returns To pack, Ready to deliver, and Ready for handoff queues,
  each with its own count and 12-card pagination. Counts cover all assignments
  in the caller's scope. Summary reads include partially picked product counts
  derived from actual allocations, including older persisted records.
- `GET /api/packing/orders/:id`: current checklist and version; admins can inspect
  unpublished/closed orders and original reports.
- `POST /api/packing/orders/:id/send`: admin assignment/publication and instructions.
- `POST /api/packing/orders/:id/pick|problem|correct|replace|packed|reopen`:
  versioned actions. Reopen is admin-only. All writes require a trusted origin.

The worker ordering-unit label comes from Product.packingUnit (for example,
`10 × 100yd Roll`); quantities are never converted. Only pending quantity is
moved on replacement; collecting from the target is confirmed separately.

Enable Worker access on an existing account in Users, then have that worker sign
in again. Existing customer/admin accounts and orders are not automatically
enrolled. Use separate browsers or an incognito window for owner/worker testing.

Digital picking allocations retain their collection/source metadata with the
order rather than using the existing 60-day expiry for legacy allocations.
Cancellation/deletion of a published task requires an explicit confirmation that
the worker has stopped and goods are physically in their original locations,
including any collection not yet confirmed in the browser. Cancellation still requires picked quantities to be returned/corrected first.
Deletion can record the confirmed return of pending picked goods and release
reservations in the same transaction. It requires the current delete-preview
revision, writes each returned quantity to the release audit, and does not add
pending-picked stock to recorded quantities again. Competing picks invalidate
an earlier confirmation. Genuine stock/receipt cleanup blockers remain in force.

No new environment variables, dependencies, or manual data backfill are needed.
Deploy the backend before the frontend when the release is approved.

The UI revision moves detailed admin progress to `/admin/orders/:id/packing`.
Order details keep a compact summary. Admins monitor by default and explicitly
enable picking edits when recording physical collection on a worker's behalf.
The worker's packed delivery assignments remain visible until delivery is
confirmed through the existing admin action; no new delivery status is added.

## Local verification

```sh
node --test tests/worker-packing.test.mjs
PACKING_TEST_URI='mongodb://127.0.0.1:PORT/megadie_packing_test?replicaSet=NAME' node --test tests/worker-packing.integration.mjs
PACKING_TEST_ORIGIN=http://localhost:5173 node --test tests/worker-packing.browser.mjs
```

The integration suite enforces a named disposable localhost database. Browser
checks intercept every API and stub clipboard writes.

Validation passed for the worker integration suite, worker browser suite on both
the development server and compiled production preview, and a real-login
end-to-end run against a disposable local replica set. The end-to-end run also
uses older persisted records with the new fields removed. Existing session,
reservation, delivery and copy-message checks passed, as did frontend lint/build.
The only build advisory is the existing large bundle warning.

A late read cannot overwrite a newer confirmed checklist version, and immediate
duplicate taps are blocked before issuing another write. Slots with outstanding
reservations cannot be deleted while they are sources for active orders.

Real-login end-to-end verification:

```sh
PACKING_E2E_URI='mongodb://127.0.0.1:PORT/megadie_packing_e2e_test?replicaSet=NAME' PACKING_TEST_ORIGIN=http://localhost:5173 node --test tests/worker-packing.e2e.mjs
```

The end-to-end browser redirects every API request to its own disposable local
server; it never sends test requests to the configured development API/database.
