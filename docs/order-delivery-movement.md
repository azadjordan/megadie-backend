# Order delivery movement

Delivery records sit on the existing Order. No courier directory, new role, or master order status is introduced. Existing orders need no backfill.

## Admin flow

The normal flow is **Ready → Out for delivery → Delivered**.

- Ready orders show **Mark out for delivery**. Its short confirmation has one optional **Handed to** name, for a courier or someone from the company. No method selection or routine checkbox is needed.
- After departure, the next action is **Mark delivered**. Its confirmation records actual customer receipt.
- Before departure, **Mark delivered** is available under More for customer collection or delivery that already happened. No departure timestamp is invented.
- **Delivery history** is available under More. It preserves each attempt and actor without cluttering routine confirmations.

The same actions appear on Order details. Only the next routine action is prominent. Icons accompany each action. Courier and company deliveries share the blue Out for delivery badge.

The explicit confirmation button acknowledges the physical event. Live packing still requires all items picked and Packed. For manual preparation, the confirmation explains that the complete order must be prepared from its reserved slots; the server records those sources as picked to protect shelf counts.

Payment remains independent. Stock finalization still requires Delivered + invoice; departure does not deduct stock.

## Delivery contact and address changes

Admins can edit the recipient, phone numbers, address, map and notes for Processing or Shipping orders, including packed orders, goods out for delivery and goods returned to the store. These order-only edits do not change packing progress, reservations, custody or the client's defaults. Delivered and Cancelled orders keep their recorded delivery details read-only.

The delivery-details modal links to the client's default delivery settings in a separate tab. While goods are out, it reminds the admin to pass updated details to whoever is delivering; saving does not send a message. Assignment and preparation changes retain their worker and physical-return guards. Saving details requires the current delivery revision and refreshes the worker's cached order details.

## Unsuccessful delivery and stock changes

While goods are out, More offers **Returned to store**. Its short confirmation records all goods physically back. The order stays packed, delivery returns to Awaiting delivery, and reservations remain held. Another departure or direct customer receipt can be recorded.

There is no return-to-shelves action in routine delivery controls. When an admin chooses **Edit items** on a returned order, or **Change reservations** on its Stock tab, the site asks for the one relevant confirmation: **Every unit is physically back in its original slot.** Continuing clears the picked ledger, reopens packing, and retains reservations before opening the requested editing flow.

Deletion stays blocked while goods are out. Once returned to the store, its existing delete preview requires the current revision and physical original-slot return confirmation. Stock release/restore stays atomic.

These are whole-order movements and returns before successful delivery. Partial shipments and customer returns after completed delivery are outside this feature.

## API and consistency

Admin-only GET/POST `/api/orders/:id/movement` reads current readiness/history and records events. POST requires a trusted website origin and `expectedRevision` from GET. The existing reservation revision fences delivery, picks, allocation/item changes, assignment, deletion, cancellation and generic order updates. Delivery writes and stock locks share a transaction; failed/stale writes leave no partial event or pick changes.

The existing PUT `/api/orders/:id/deliver` remains a receipt action, uses the same checks, and preserves its response shape. It cannot be used to record other movement events.

The current delivery snapshot and admin-only history preserve each attempt's actual timestamp, handler and actor. Existing method details and notes remain readable in history. The history is excluded from list queries; internal movement data is stripped from customer responses. The worker delivery extension provides scoped assignments and movement controls through separate staff endpoints; see [Worker delivery](worker-delivery.md). Picking stays read-only while goods are away.

The confirmation guards repeated submission. Names are optional and a missing name is never invented. After any uncertain/conflicting save, the admin checks latest delivery details and confirms again. Reading a committed event recovers a lost response without repeating it. A departure confirmation never silently changes into a receipt action after refresh.

## Validation / release

Tests use guarded disposable localhost databases or intercepted browser APIs. No production records are seeded or modified.

- `tests/order-movement.integration.mjs`: methods, receipts, exact reservations, physical confirmations, stock/cancel/delete/edit guards, active order-only delivery edits, worker packing/queues, returns/reshelving/retry history, stale requests and concurrent release/departure.
- `tests/order-delivery.browser.mjs`: editable active destinations, closed-order explanations, client-default links, order-only saves and existing copy/default/conflict flows.
- `tests/order-movement.browser.mjs`: real UI actions, return confirmations, lost-response recovery, keyboard dismissal and 320/390/1440px layout.
- Existing packing, delivery-details, list, navigation and real-login packing/help tests remain part of verification. The help end-to-end flow now records departure and receipt separately before finalization with a partly paid invoice.

Deploy backend first, then frontend. Existing fields default safely without a migration. A local backend restart is needed because its Node process does not reload source changes automatically.
