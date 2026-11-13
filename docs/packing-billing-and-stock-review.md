# Packing, invoicing and stock-report review

The normal live-packing sequence is reserve, send to worker, pick/resolve
shortages, mark Packed, invoice, then hand over/deliver using the existing
controls. These changes apply to live worker packing and use existing collections.

## Invoice timing

Order invoices are rejected while `packingSentAt` exists and `packedAt` does not.
Picking every quantity alone does not unlock invoicing: the worker still checks
and packs the carton. The admin details page shows the reason beside the disabled
invoice action. The order-list primary action guides packed live orders without
an invoice to Invoice before Deliver. Existing delivery permissions remain.

First publication rejects an already linked or orphaned order invoice, before
worker assignment, stock reservations or saved instructions can change. The
assignment dialog explains the billing conflict and links to order billing.
It also explains the expected sequence before publication. Existing unpublished
orders retain their legacy invoicing/preparation paths. Existing published
invoiced tasks remain readable and can finish picking; their financial editing
lock still applies. No invoice or payment is automatically removed or changed.

An invoiced packed task cannot be reopened until billing is resolved. Invoicing,
publication, item changes and reopening serialize on the same Order document.
Invoice creation uses the existing retrying transaction helper and increments
the reservation revision; failed attempts roll back the revision and invoice.
A concurrent publication/invoice or reopen/invoice pair cannot both succeed.

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
