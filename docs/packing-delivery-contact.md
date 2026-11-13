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
an admin can correct them in Worker assignment → Change assignment.

No new model, migration, required contact field or dispatch/invoice rule is added.

Verification: `tests/worker-packing.integration.mjs` covers contact preservation,
privacy, defaults, reassignment, explicit clearing and failed-save rollback.
`tests/worker-packing.browser.mjs` covers editing and mobile contact display.
`tests/worker-packing.e2e.mjs` uses real login and an explicitly named disposable
localhost database to reproduce an older form save and verify the worker view
after reload. Phone links are inspected without launching a dialer.
