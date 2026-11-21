# Worker delivery assignments

Packing and delivery use the existing Worker access flag and separate assignments on Order. No new role or courier directory is added.

## Flow and UI

Admin reserves goods and assigns packing. Pack & deliver initially assigns delivery to the same worker; Pack only leaves delivery unassigned unless someone was already independently assigned. Existing picking and shortage controls lead to Mark packed.

For deliveries without an assigned worker, admins choose Azad, Momani, Courier (with a required name), or Customer collection. Owner choices store the existing company method with the canonical owner name; they never assign a worker or generate worker delivery credit. New owner movements require an explicit valid owner, while existing departures keep their recorded name through receipt, returns and corrections.

Only admins can Assign delivery, Change delivery worker, remove an assignment, or list enabled workers for selection. Workers receive their own unfinished packing or assigned delivery jobs, with no assignment controls. Once packing-only work is finished, it leaves active work and both saved task links are restricted to the worker's own recent-work receipt and its privacy window. This records responsibility, not movement. Packing, invoice, reservations and shelf quantities stay saved. Assignment remains available after packing and invoicing. During departure only an admin may reassign, with explicit acknowledgement of physical responsibility transfer.

The current delivery worker uses Mark out for delivery when the complete order leaves, then Mark delivered after complete customer receipt. Waiting for packing cannot depart. Admin-prepared orders retain the complete-preparation confirmation on departure. Returned to store under More confirms all goods are back; goods remain packed and reserved. Shelf return remains an admin action.

Receipt confirmation names the client and order and states that the complete order was received. Partial, refused or failed deliveries require admin review; the confirmation reminds the worker to contact an admin before proceeding. No partial-delivery status or extra approval step is introduced.

My work has Active work and Recent work views. The combined active feed shows one card per order and its current packing or delivery action, with compact Waiting entries. A delivery-only worker sees delivery jobs directly, and combined assignments transition from packing to delivery without duplicate cards. Cards show client, carton reference, delivery status, recipient/address, map/directions and calling. Details add notes and a price-free item summary. Completion stays visible on the open detail page with success feedback and leaves the active list. Delivery access does not grant picking, inventory, billing or access to other customers/orders.

Admin orders offer Packing worker and Delivery worker separately. Order details and packing monitoring include a compact delivery assignment panel. Removing packing retains the independently managed delivery assignment, as explained in its dialog.

## Data and consistency

- `Order.deliveryWorker` references User. Missing means legacy fallback to the packer on published Prepare & deliver tasks. Explicit null means unassigned and never falls back. Existing orders need no backfill.
- Packing publication/changes preserve a separately assigned driver. Removing packing materializes any legacy delivery assignment before clearing packing access.
- Movement and history store driver references alongside actor and handler names. Assignment events store previous/current driver and actor.
- Delivery details belong to the order. Legacy defaults are snapshotted on assignment/departure. Only the current driver/admin receives contacts; a packer whose order is delivered by someone else receives assignment information without recipient details.
- Actor/target Worker access and assignment are checked under transaction locks. Assignment and movement use the existing reservation revision. Workers cannot edit financial fields or invoke admin movement exceptions.
- Confirmations retain the reviewed revision; background reads cannot silently replace it. Uncertain/stale writes require a fresh read and explicit confirmation. Offline, double submissions, reassignment and revoked access are guarded.

## API

Staff endpoints under `/api/packing/deliveries`:

- GET `/`: assigned active orders, bounded pagination. The existing delivery list endpoint is retained for compatibility and admin views.
- GET `/api/packing/my-work`: worker-scoped unique active packing/delivery cards, To do and Waiting counts and pagination.
- GET `/:id`: scoped task and permissions.
- GET `/:id/workers`: admin-only selection of enabled worker ids/names.
- POST `/:id/assignment`: admin-only; `workerId` (or admin-only null), `expectedRevision`, trusted origin; admin `confirmedHandover` required while out.
- POST `/:id/movement`: existing transactional movement service, scoped response. Worker actions are departed/delivered/returned only.

Existing `/orders` movement routes stay admin-only. Customer responses omit delivery worker and internal history.

## Corrections

Completing delivery deletes the linked source quote for both admin and assigned-worker confirmations. Quote deletion, receipt status and event history commit together; a deletion failure rolls the entire confirmation back. Departure, cancelled confirmations and rejected attempts retain the quote. Invoices, payment records, picked quantities and shelf stock remain unchanged by receipt.

Admin More → Correct recorded status requires a reason and acknowledgement. Mistaken receipt restores Shipping and the previous out/ready state. Mistaken departure restores ready-in-store with the packed pick ledger retained. History keeps the mistaken and correction events. Finalized/deducted stock blocks correction. Invoice/payment records remain unchanged; deleted source quotes are not recreated. Actual physical returns use Returned to store.

## Navigation

Directions use the saved Google destination/place identity when available, otherwise the order's address. Opaque map links open unchanged as Open map, preserving the exact pin over a less precise address. Navigation requires HTTPS. No embedded maps or route-planning service is introduced. Address directions follow [Google's Maps URL documentation](https://developers.google.com/maps/documentation/urls/get-started).

## Validation and rollout

Tests use strictly named disposable localhost replica-set databases or fully intercepted APIs. No production records are seeded.

- `worker-delivery.integration.mjs`: legacy/null defaults, assignment independence, privacy/roles, invoiced orders, stale/disabled workers, missing locations, races, returns and corrections.
- Receipt regression checks cover admin/worker quote deletion with unpaid, partly paid and paid invoices, rejected confirmation, replay and quote-deletion failure rollback. The real-login mobile flow verifies cancellation before confirmation, retained payment/stock records and quote deletion after receipt.
- `worker-delivery.browser.mjs`: cards/details, maps/calls, waiting/completion, background revision changes, lost responses, offline, access loss, corrections and phone/desktop layouts.
- `worker-delivery.e2e.mjs`: separate admin/packer/driver logins, admin assignment, departure/receipt, retained pick and shelf quantities.
- Existing packing, movement, delivery, list, help and billing/stock suites remain applicable. Frontend URL tests check safe encoding and destination identity.

Deploy backend first, then frontend. Restart the plain Node local backend to load routes. Older orders retain their assigned driver through the legacy fallback.
