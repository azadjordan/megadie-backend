# Admin order item changes

Implemented locally. Existing order/worker plans remain applicable.

## Scope and behavior

Admins can edit Shipping orders before invoicing or stock finalization. Packed
orders must first be reopened. The general order-update endpoint still rejects
item changes. Worker/customer accounts cannot access editor, search, preview or
save endpoints. Website mutations require a trusted origin.

Existing lines retain product and unit price. Admins can change quantities,
remove lines, or add active products with an explicit agreed price. Adding an
existing SKU again is rejected; legacy duplicate lines keep their individual
prices and share the product's picking target.

Unchanged products and their reservations/picks are retained. For reductions,
release unpicked quantities first, preferring reported shortages. If the new
target is below picked quantity, identify exact original locations and returned
quantities. Return fewer locations first with deterministic ties. Recorded stock
already includes pending picks: a confirmed return does not add stock again.

For added quantities, reuse active AE1 stock, respect all other orders' holds,
and exclude locations reported short on this order. New reservations have zero
picked quantity. An unavailable item blocks the entire save without changing
order lines, existing picks, reservations, prices or history.

Removing every line requires explicit whole-order cancellation. Record returns,
release reservations, clear the active worker task, and keep the original item
list and reports on the cancelled order. Do not save an empty active order.

## APIs

- `GET /api/orders/:id/items-editor`: latest lines, picked/reserved quantities,
  fees, version, eligibility reason, and the last ten admin-only history entries.
- `GET /api/orders/:id/item-products?search=...`: up to twelve active SKU/name
  matches with available AE1 quantity. Search needs at least two characters.
- `POST /api/orders/:id/items-preview`: `{expectedRevision, items}`. Existing
  rows use `{key: "line-N", qty}`; new rows use `{productId, qty, unitPrice}`.
  Returns issues, exact returns, before/after totals, cancellation intent, and a
  deterministic plan token. Preview performs no writes.
- `PUT /api/orders/:id/items`: the same draft and expected revision, its preview
  `token`, `confirmedPhysicalReturn` when needed, and `cancelOrder: true` when
  removing all lines. Returns the saved version and cancellation status.

Save locks the current admin, order and affected stock in one transaction,
recomputes the plan, and rejects stale versions or changed plans. The preview
and save use the same pure planning function. Audit failures roll everything
back. Repeating an earlier successful request cannot apply its changes twice.

The editor preserves drafts after failed saves. A stale picked total can be
reloaded while retaining edits. If another admin changes line identities, load
the latest list and keep the earlier draft as a read-only reference; never map
old line indexes onto different products automatically. Refresh resets return
acknowledgement and requires checking the new plan.

## Storage and screens

No new collection: additive hidden `Order.itemChanges` records who/when,
before/after lines and prices, returns and cancellation. Original shortage
reports stay intact. Reservation changes reuse InventoryMovement audits.
Packing activity provides a financial-data-free revision/date/actor notice to
workers. History/prices are never added to worker or customer responses.

One editor lives on order details, opened beside Order items or Reserve Stock.
Packing shortages link directly to the same editor with the product highlighted
and return to packing on close. Product search stays inside the editor. Its
header and footer remain visible while long content scrolls, including phones;
closing an edited draft requires Keep editing or Discard changes.

Reservation-status recalculation also now selects delivery/extra fees before
saving an order, preserving its full total instead of recomputing only items.

## Checks

```sh
ORDER_ITEMS_TEST_URI='mongodb://127.0.0.1:PORT/megadie_order_items_test?replicaSet=NAME' node --test tests/order-item-changes.integration.mjs
ORDER_ITEMS_E2E_URI='mongodb://127.0.0.1:PORT/megadie_order_items_e2e_test?replicaSet=NAME' node --test tests/order-item-changes.e2e.mjs
```

Tests enforce named disposable localhost databases and never load `.env` or
`server.js`. Browser tests redirect every API call to their isolated server.
Worker/reservation regressions and frontend lint/build are also checked.
