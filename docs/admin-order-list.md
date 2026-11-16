# Admin orders list

The refreshed list uses five content areas, one recommended next action, the
existing dialogs and a secondary More menu. Billing contains invoice/PDF access
and Record payment. Physical collection, invoicing, delivery and inventory
finalization remain separate existing operations.

GET /api/orders adds admin-only listAction, listReviewReason, helpRequestedItems
and invoiceLinkMissing facts. The same read-only aggregation drives the new
work filters and counts before pagination. It selects only the fields needed
for those facts; internal help notification/report data is not exposed.

New work filters: needsAdmin, preparation, toInvoice, toDeliver and toFinalize.
The summary also contains all. Existing work filters and their meanings remain
compatible. needsStockCheck remains distinct from stock finalization and includes
closed orders. Shortcut counts are global order counts, not report/product counts.

paymentStatus=paymentDue is a new issued-invoice/positive-known-balance filter
that combines with work/search/status. Existing notFullyPaid continues to include
uninvoiced orders. An issued zero-value invoice can be Unpaid with no balance;
the UI does not relabel that as Paid or offer a zero-value payment.

Active help uses the existing unresolved-help semantics. An unhandled slot
shortage alone is not a new request for admin help. Unchecked original reports
remain visible after picking, billing, delivery and stock finalization.

No model, environment variable, dependency or manual migration is added.
Deploy the backend before the frontend. Existing server transaction/role/version
and physical-return guards remain authoritative; a list recommendation does not
bypass them or add an invoice/payment gate to delivery.

The frontend implementation/acceptance plan is in the frontend repository at
docs/admin-orders-page-refresh-plan.md. Tests use intercepted APIs or explicitly
named disposable localhost databases, never configured production test records.

Targeted read test:

    ADMIN_LIST_TEST_URI='mongodb://127.0.0.1:PORT/megadie_admin_list_test?replicaSet=NAME' node --test tests/admin-order-list.integration.mjs

The real-login packing-help test now also covers filtered-list return context,
partial payment, delivery while partly paid, finalization and retained stock
reports. Existing worker/deletion, item editing and delivery/copy checks pass.
