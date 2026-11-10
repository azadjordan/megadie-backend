# Reserve all items

The Reserve Stock section of the admin order details page offers one order-wide
action. It checks fresh stock and reservations for every item before saving any
new allocations. If any item is short or has an invalid existing reservation or
stock location, it returns every affected item and commits no changes. Existing
reservations and their notes/actors remain unchanged.

## Selection and reporting

- Only Shipping, unfinalized orders without deducted allocations can reserve.
- Aggregate repeated product lines into one ordered quantity.
- Preserve existing reserved slots and quantities. Choose additional unused
  slots by on-hand quantity ascending, creation time descending, then id.
- Recommended slots must have a valid label and belong to AE1, matching the
  worker sheet's store requirements. Stock held by other orders is unavailable.
- Existing slots are not topped up automatically. If their spare stock is needed,
  report the shortage in unused recommended slots and let the admin adjust those
  picks explicitly using the individual controls.
- Report SKU/product, ordered, already reserved, still needed, available in
  recommended slots, shortage, and an actionable issue description.
- Finalize Stock remains the step that deducts on-hand stock.

## API and consistency

`POST /api/orders/:id/allocations/reserve-all` is admin-only and accepts no
client-supplied plan. Success returns `data.itemCount`, `data.addedQty`, and
`data.reservationCount`. Expected rejections return HTTP 409 (404 for a missing
order), `noNewReservations: true`, and, for item issues,
`code: "RESERVATION_BLOCKED"` plus `issues`.

Allocation writes, RESERVE audit movements, and order allocation status updates
share one MongoDB transaction. Internal `reservationRevision` writes on the
order and candidate SlotItem documents serialize conflicting manual and bulk
requests, including requests belonging to different orders. Transient conflicts
retry against fresh state within a bounded transaction timeout. Guards also
conflict with stock edits/moves/finalization that write those documents. They do
not change on-hand quantity, occupancy, or stock timestamps. No backfill is
required; `$inc` initializes guards on older records.

Manual save/release operations use the same transaction path. Repeated bulk
requests reserve only remaining quantities, without duplicate audit movements.

The UI keeps errors inline, provides item review/focus and retry, and refreshes
reservation and availability caches. Competing edits are disabled while working.
A lost/failed response is treated as an unconfirmed result: the admin must
refresh reservations before trying another write. A successful response followed
by a failed refresh remains a confirmed save and offers a read-only refresh.

## Verification

```sh
node --test tests/order-reservations.test.mjs
RESERVATION_TEST_URI='mongodb://127.0.0.1:PORT/megadie_reservation_test?replicaSet=NAME' node --test tests/order-reservations.integration.mjs
RESERVATION_TEST_ORIGIN=http://127.0.0.1:5173 node --test tests/order-reservations.browser.mjs
```

The integration suite accepts only the named disposable local database, never
loads `.env`, and drops its test database. Browser checks intercept all APIs.
