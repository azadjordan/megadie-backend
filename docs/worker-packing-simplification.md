# Worker picking and packing refinement

This change keeps the two worker pages and existing reservation/picking records. It adds no database models or business statuses.

## Orders

Cards show client, short carton reference, units picked, a unit-based progress bar, product completion and the next action. Empty queues stay visible as compact messages. Partial quantities are visible even before any product is complete.

- Nothing picked: Start packing.
- Partly picked: Continue packing.
- All quantities picked and the saved locations valid: Ready to pack / Mark packed, with Review items available.
- Packing confirmed: Packed / View packed order or View delivery.

100% picked stays blue until packing is confirmed. Mark packed is a separate button, not nested inside a navigation link. It uses the same completion endpoint and current readiness checks as the order page, with the reservation revision from the card. Double taps, offline use, stale cards and uncertain responses are guarded; an uncertain result is read before another completion attempt.

## Packing page

Identity stays at the top. The full carton label is available through a quiet disclosure. The sticky footer carries units picked/remaining and product completion, plus Mark packed. Completed products stay in place; there is no automatic collapsing or reordering. A successful pick highlights the next usable location. Explicit continuation to another slot brings it into view.

Product and slot quantities retain their selling units. Overall counts sum the order's selling quantities, without converting package contents into pieces. Unit progress is derived from order items and saved active allocations; it is not an independent maintained stock counter.

## Not enough here

The shortage sheet asks **How many did you take this time?**, with the already recorded count and a maximum equal to the unpicked part of that slot. A blank entry is not silently treated as zero. Corrections remain cumulative actual totals in a separate Correct count screen, with the existing physical return acknowledgement for reductions.

The sheet immediately shows the picked total, missing quantity and compact alternative rows. Each alternative offers **Continue at [slot] — [quantity]**. Partial alternatives say how much will still be needed elsewhere. Notes are optional behind Add a note.

There is no Save shortage step. Continuing to an alternative first saves the actual picked total and shortage through the existing problem action, then moves only the unpicked reservation through the existing replacement action using the returned revision. The replacement is never marked picked automatically.

If replacement fails, the saved picked count remains. After checking latest progress, only the unresolved work is retried. A lost response cannot silently add the incremental quantity twice. Drafts are fenced to the revision/quantities on which they were entered.

Ask admin for help records the same physical count first and reuses existing help/Telegram notification logic. An already created automatic help request is not sent again. Workers can continue elsewhere; unresolved shortages still block Packed. If an admin resolves a shortage while its saved panel is open, the panel shows the resolution and returns to the current picking list.

## Verification

Use disposable local replica-set databases or fully intercepted browser APIs. Do not seed or modify the configured production database for tests.

- Pure checks: unit totals across partial/split picks, duplicate product lines and cancelled reservations; completion readiness.
- API checks: current unit totals and revision in card DTOs; stale completion rejected; same underlying picking, slot, assignment and completion guards.
- Browser checks: additional versus cumulative quantities, single-action continuation, partial alternatives, replacement conflicts, lost count/completion responses, card completion without navigation, notes, keyboard/session behavior, mobile layout and existing admin actions.
- Real login end-to-end checks: actual partial picking/replacement/packing, shortage help/admin resolution, invoice/payment/delivery/finalization, and physical-return deletion on isolated local databases.

Deploy the backend before the frontend. Older orders need no backfill; their totals are derived on read. Restart the plain Node local backend to load the updated DTOs.
