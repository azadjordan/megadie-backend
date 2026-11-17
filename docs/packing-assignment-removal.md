# Remove a worker assignment and continue manually

Implemented locally on 16 November 2026. No schema migration or new preparation
mode. Deploy the backend before the frontend for this addition.

## Admin flow

Open More → Worker assignment → Remove worker assignment. The same dialog is
available through Worker assignment in the order details Packing summary and
on the packing page.

Confirm: “The worker has stopped, and all goods are in their original slots.”
Then choose Remove assignment. The dialog closes and opens the order's Stock tab,
retaining the list's filters/page context. Existing reservations remain available
for manual preparation; the admin does not need to reserve the order again.
The manual packing-message option is available again under its usual checks,
including entering the person responsible when preparing a message.

## Conditions

- Admin only, with an active published task on a Shipping order.
- No Packed confirmation, invoice (including a linked or unlinked invoice record),
  deducted allocation or stock finalization.
- All non-cancelled allocations have zero picked quantities. The checkbox never
  overrides saved picks. Return goods and use the existing correction flow first.
- Current order and delivery revisions must match. A concurrent pick, reservation
  edit, reassignment or instruction change forces a refresh and a new confirmation.

Completed/invoiced work retains its existing reopening and billing safeguards.
Removal does not reopen packing, reset picked quantities, cancel an order, delete
an invoice, release reservations, or change shelf quantities.

## Stored result and access

Clear the live worker id, publication/handover timestamps and assigned-to name.
Keep the order, reservations, task type, delivery snapshot, stock reports and
previous activity. Increment the existing order/delivery revisions and append
ASSIGNMENT_REMOVED with the admin, prior worker name and physical confirmation.
Close the withdrawn task's active help requests without marking stock reports
checked. A later reassignment retains those reports and the audit trail.

Worker queries no longer include the order. Reads and stale writes from the old
worker are rejected by the existing assignment checks. An already-open worker
screen clears access on refresh or a rejected action.

Order details retains a Packing history link and outstanding report access after
withdrawal. An admin can use the same history screen to review stock reports;
there are no picking controls while the task is unpublished.

## Endpoint and recovery

POST /api/packing/orders/:id/unassign, protected by staff/admin access and the
existing trusted-origin check. Body:

```
{ expectedRevision, expectedDeliveryRevision, confirmedPhysicalReturn: true }
```

The service uses the existing order transaction/revision lock and reads actual
allocations/invoices within that transaction. No allocation or stock mutation is
needed. The response returns the updated admin packing view and lock reason.

The UI requires the checkbox, prevents duplicate submission, and disables another
attempt after a stale or uncertain result. Check latest progress reloads saved
state and clears the acknowledgement. If withdrawal already committed despite a
lost response, checking state continues to manual preparation without another POST.

## Verification

- Disposable local database integration checks cover retained reservations/stock,
  reports/history/delivery, authority and confirmation guards, picked corrections,
  completion/invoice guards, stale revisions, revoked worker access, repeat requests,
  republishing and a real concurrent pick/withdrawal race.
- Browser checks cover desktop/320px confirmation, retained list context, order-
  details entry, blockers, double clicks, new picks and uncertain-response recovery.
- Existing packing, delivery, invoice, report-review and deletion regressions remain
  in the same suites. Test databases and intercepted browser APIs isolate this work
  from the configured production database.

## Separate delivery assignments

Worker delivery adds an independent assignment. Removing packing keeps that delivery assignment (including a legacy Prepare & deliver fallback), and the dialog explains this. Manage or remove delivery separately through Delivery worker. See [Worker delivery](worker-delivery.md).
