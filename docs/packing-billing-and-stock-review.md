# Packing, invoicing and stock-report review

The physical flow is reserve, assign or prepare manually, pick/resolve shortages,
mark Packed for worker tasks, then hand over/deliver. Invoicing follows its own
timing and uses the existing collections.

## Invoice timing (updated 2026-11-20)

Invoices can be created for eligible Processing, Shipping or Delivered orders
before assignment, during picking, or after packing. An invoice alone does not
block assignment, reassignment, reopening in store, or assignment removal.
Reopening preserves picked quantities; removal still requires zero saved picks
and confirmation that the worker stopped and goods are in their original slots.
Existing custody, delivery and stock-finalization locks remain in force.

Billed products, ordered quantities, prices and charges stay locked. Workers can
report shortages and switch source slots for the same product without changing
the bill. If the client accepts fewer units, removal or substitution, the admin
reviews billing through the existing invoice screen before changing those order
lines. Existing payment/deletion protections apply; no bill is automatically
cancelled or adjusted. Admin packing and item-edit restrictions link to billing.

Invoicing does not mark anything Packed or Delivered and does not deduct stock.
A fully reserved unassigned order offers Send to worker even with an invoice;
manual preparation and its physical-readiness confirmations remain available.
Invoice presence is not evidence of manual preparation or readiness for delivery.
To invoice remains the recommended-next-step queue, while No invoice includes
other uninvoiced orders such as those still being packed.

Invoice creation, item changes and packing updates still serialize on the Order
transaction/revision fence. A stale operation reloads before retrying; invoicing
and assignment or reopening can both finish. Duplicate invoices remain blocked,
and simultaneous item editing cannot leave an invoice mismatched with the order.
Creating or deleting an invoice refreshes affected order/packing caches.

## Stock-report review

Original shortage reports gain optional `checkedAt`, `checkedBy` and
`checkedByName`. The existing Order gains hidden `packingReportsRevision`.
No collection or manual backfill is added. Old reports without a checked date
automatically count as needing a stock check.

The admin orders list has a Stock checks filter, order badges and a work-summary
count. This includes packed, Delivered and Cancelled orders. Order details link
directly to the stock reports on the packing page. Counts are calculated from
reports; reducing quantities, replacing slots, packing, invoicing or closing an
order does not remove unchecked reports from the queue.

Admins choose Mark checked after investigating the source slot and completing
any necessary inventory correction. If correction is still pending, leave the
report unchecked. The existing count guards still apply while picked goods
remain included in on-hand balances; finalize the relevant orders or record
actual returns through existing controls before correcting those shelf counts.
Mark checked only records a review. It cannot adjust stock, picked quantities,
reservations, active help requests, prices, invoices or financial totals.
Reopen check reverses a mistaken review; existing packing activity records both.

The review endpoint is `PATCH /api/packing/orders/:id/reports/:reportId` with
`{checked: boolean, expectedReportsVersion: number}`. It requires a fresh admin
role, authenticated trusted-origin request and current report version. Closed
orders remain reviewable. Workers/customers get no report-review metadata or
permissions. A separate report version avoids invalidating worker quantity
drafts. New shortage reports increment that version and start unchecked.

The query cache keeps picking and report-review revisions independently, so
late reads cannot undo either confirmed state. Unknown/failed review saves keep
buttons blocked until Load latest reports succeeds. Reopening a check or loading
another device preserves reviewer/time metadata and original report snapshots.

## Verification

Use explicitly named disposable localhost databases; browser API traffic is
fully intercepted or redirected to those local test servers. Telegram delivery
remains simulated in tests.

```sh
PACKING_REVIEW_TEST_URI='mongodb://127.0.0.1:PORT/megadie_packing_review_test?replicaSet=NAME' node --test tests/packing-billing-stock.integration.mjs
node --test tests/worker-packing.browser.mjs
PACKING_HELP_E2E_URI='mongodb://127.0.0.1:PORT/megadie_packing_help_e2e_test?replicaSet=NAME' node --test tests/packing-help.e2e.mjs
```

The real-login flow covers shortage, partial replacement, admin quantity change,
Packed, invoice creation, Stock checks discovery, review/reopen and retained
original stock evidence. The supervised store trial is described in
[packing pilot](packing-pilot.md).
