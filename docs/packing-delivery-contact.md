# Delivery contacts for packing assignments

The worker-assignment editor includes optional recipient name, phone and backup
phone fields for Pack & deliver. Existing order instructions prefill the editor;
customer profile defaults are suggested only when the order has no saved
delivery snapshot. Switching task mode or reassigning a worker keeps those
instructions and existing picked quantities.

Assignment saves merge supplied delivery fields with the saved order snapshot.
Omitted fields keep their saved values, including when an older client sends
only address, map and notes. An explicit empty string clears a field. Current
delivery and picking revisions still protect concurrent changes, and all edits
commit with the assignment in the existing transaction.

Only the assigned delivery worker can read these contacts through the worker
API. Pack-only tasks return no delivery details; work queues contain no contact
numbers. Delivery details show the recipient and Call actions for the primary
and backup numbers. Common numeric phone formats become `tel:` links; unsupported
text, including extensions, remains readable without an automatic dial action.
Missing numbers explain that the worker can ask an admin for help.

Saving the customer location still updates only the profile address and map.
Order contact edits do not overwrite profile contacts. Previously erased order
contacts are not guessed or replaced from a possibly different profile recipient;
an admin can correct them in Delivery / courier details, including after packing
or departure without changing the assignment.

## Shared client location rules (2026-11-18)

Worker assignment, manual preparation and Delivery / courier details show the
same location controls: **Use client's default** fills the draft, and **Also save
this address and map for future orders** explicitly promotes the order location.
The latter updates only `User.address` and `User.deliveryGoogleMapsUrl`. The order
and optional default commit together; saving a default through the delivery
editor does not require a packing assignment or a particular preparation mode.
Pack-only saves preserve the saved destination instead of applying hidden edits.

Both profile endpoints and both order-saving paths share location validation and
stale-write protection. A profile request that supplies `address` or
`deliveryGoogleMapsUrl` must include `expectedCustomerLocation` with the original
trimmed `{ address, googleMapsUrl }` pair. Unrelated profile edits omit location
fields. A conflicting location returns 409 without saving the rest of the edit.
The document save also checks the original stored pair to catch a concurrent
write after the initial read. Existing order delivery revisions remain required.

An address change retaining the previous nonempty map requires
`confirmedMapLocation: true`, or the map must be changed/cleared. This applies to
both the order and any client default being replaced. Profiles use the same
HTTPS-link and length validation as order locations. Blank saved order fields
remain authoritative; future default changes do not rewrite existing orders.

Successful default saves invalidate client and order/packing caches. Refreshing
the client editor preserves unsaved fields; an explicit reload discards a draft
only after confirmation. No existing client default or historical destination is
automatically backfilled.

No new model, migration, required contact field or dispatch/invoice rule is added.

Verification: `tests/worker-packing.integration.mjs` covers contact preservation,
privacy, defaults, reassignment, explicit clearing and failed-save rollback.
`tests/worker-packing.browser.mjs` covers editing and mobile contact display.
`tests/worker-packing.e2e.mjs` uses real login and an explicitly named disposable
localhost database to reproduce an older form save and verify the worker view
after reload. Phone links are inspected without launching a dialer.
`tests/order-delivery.integration.mjs` additionally covers profile conflicts,
concurrent profile saves, transactional default updates, validation and history
preservation. `tests/order-delivery.browser.mjs` covers both location dialogs,
the profile forms, map review, cache refresh, drafts and mobile layout.
