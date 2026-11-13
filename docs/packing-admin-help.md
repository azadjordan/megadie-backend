# Packing shortages and admin help

Workers report a shortage with **Not enough here**, the total physically
collected from that slot (including earlier picks), and **Save shortage**.
The existing Need / Picked / Missing arithmetic and optional note remain.
Alternative same-product locations appear after the shortage is saved.

If no alternative remains, including after a partial replacement, the same
transaction saves an admin-help request. If locations are suggested but unusable,
the assigned worker chooses **Ask admin for help**. This requires a saved active
shortage and the current packing revision. Admins cannot request help on behalf
of themselves; their existing shortage controls and order editor remain.

One active request covers all affected slots for a product. The worker sees
**Admin help requested** on the product and order card, with an instruction to
continue other items. There is no new queue, approval or acknowledgement step.
Saved shortage panels continue refreshing; unsaved quantity drafts pause polling.
Original reports remain historical evidence, even when current help is resolved.

Normal slot actions say **Picked all 37** or **Picked remaining 30**, with the
packing unit shown beside the instruction. A reported-short slot displays its
missing quantity and **Review shortage** instead. The server rejects `pick` for
reported-short allocations, including requests from old clients and admin assist.
**Update picked total** requires an explicit quantity and uses the existing
`problem` action. An actual total meeting the slot target resolves the shortage;
partial totals retain it. No report or original stock discrepancy is erased.

**Continue picking** focuses and highlights the next unfinished usable slot,
skipping reported shortages, completed and unavailable locations, and wrapping
to earlier work. A fully replaced shortage leads directly to its target slot.
Navigation never records a pick. With no usable slots, show the saved help state
and a link to choose another order; remove this message if admin changes make
work available or the current order ready to pack.

The secondary **Correct count** form uses the same absolute picked-total entry.
Only a decrease needs confirmation: **I put 3 back in A1, or the earlier count
was wrong.** The actual difference and slot are inserted. Blank or invalid
quantities show no misleading return quantity. The final **All items picked**
message instructs the worker to check and pack the order before **Mark packed**.
Ordinary corrections show **Left to pick** rather than declaring a shortage.
The final bar is sticky only when ready, so its disabled state never covers
ongoing picking actions.

## Storage and resolution

The existing Order has an additive hidden `packingHelp` array containing the
product, requester, date, reason and notification state. No new collection or
external queue is introduced. Worker DTOs expose only per-product request time
and the count of products needing admin help. Customer order responses exclude
these internal fields. Notification attempts never alter the packing revision.

Reservation/item changes resolve help when the current product no longer has a
reported shortage or insufficient reservations, or leaves the active order.
Unrelated edits preserve it. A fresh problem after resolution starts a new
episode. A failed/stale save cannot create a request or mutate picked quantities.
Reservation replacements retain collected goods and never mark the target picked.

Admin item changes record a quantity-only summary on existing packing activity:
SKU, product, previous quantity, new quantity and packing unit. Workers see the
latest change notice for removed/added/reduced/increased items, without prices
or the full admin audit. Physical-return rules remain in the existing editor.

## Telegram delivery

Requests are saved before sending. The API kicks the dispatcher only after a
successful transaction; the app also checks pending alerts every 15 seconds
after connecting to MongoDB. Background delivery uses the existing
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` and `FRONTEND_URL` configuration.
Existing request/account alerts keep their Markdown mode; packing uses plain
text so client names, notes and SKUs cannot break Telegram formatting.

Alerts contain client, order, SKU, worker, ordered/picked/remaining quantities,
reported shortage and affected slots, recent product notes, and the authenticated
admin packing link. Quantities are refreshed at delivery, rather than freezing
an outdated shortage snapshot. Remaining quantity also includes goods reserved
elsewhere but not picked; reported missing is shown separately.

An atomic claim with a 60-second lease prevents simultaneous delivery by app
instances. Each network request times out after 8 seconds. Failed alerts retry
after 30 seconds, 2 minutes, 10 minutes, 30 minutes, then hourly; claims can be
recovered after a restart. Pending resolved/closed requests are skipped. There
are no notification states for the worker to manage or repeat-report buttons.

Delivery is at least once: if Telegram accepts a message and the process stops
before recording success, a retry can deliver a duplicate. Ordinary repeated
taps, saves and refreshes reuse the existing request and do not send more alerts.
The existing admin Needs attention view remains available if Telegram is down.

## Verification

Integration tests require explicitly named disposable localhost databases.
Notification tests inject delivery and never send real Telegram messages.
Browser APIs are fully intercepted or redirected to the isolated test API.

```sh
PACKING_HELP_TEST_URI='mongodb://127.0.0.1:PORT/megadie_packing_help_test?replicaSet=NAME' node --test tests/packing-help.integration.mjs tests/telegram-alert.test.mjs
PACKING_HELP_E2E_URI='mongodb://127.0.0.1:PORT/megadie_packing_help_e2e_test?replicaSet=NAME' node --test tests/packing-help.e2e.mjs
node --test tests/worker-packing.browser.mjs
```
