# Ribbon stock reconciliation preview

Run from the backend:

```sh
node operations/preview-ribbon-stock.mjs
```

Optional positional argument: normalized CSV path. Requires Python 3 for standard CSV parsing. Default input is ../ribbon_stock_db_sizes.csv. CSV stays unchanged. No apply mode exists.

Reads production-db with a MongoDB snapshot session; no database mutations or collection/index creation. Scope is Ribbon, AE1, shelves D–R; A/B/C/FLOOR and other stores/materials are excluded. Product matching includes material, code, size, grade, 100yd packaging and satin Single Face. Grouping combines only identical products in the same slot.

Reset baseline is ae1-ribbon-reset-2026-10-11T10-50-52-326Z. The audit verifies 486 reset movement entries and checks subsequent recorded activity using both eventAt and createdAt, including move endpoints. Existing target Ribbon stock, active reservations (including legacy missing statuses), ambiguous matches and invalid quantities/CBM block reconciliation. Capacity excess and empty locations are review items, not reasons to change counts automatically. Unrecorded physical activity cannot be detected.

Outputs to /Users/azad/Backups/megadie/ribbon-stock-preview-<timestamp>: summary.json, stock-preview.csv, plan.json, issues.json, occupancy.json, movements.json, allocations.json and source-snapshot.json. These data files remain outside Git. Plan quantities are hypothetical additions, not an approved import. Re-run before applying any future import; use a batch fingerprint and transaction in the separate importer.

Other products in each target slot contribute to occupancy. Missing CSV rows never mean stock deletion. The protected inventory fingerprint is a baseline for a later apply operation, not a claim that concurrent business activity cannot change inventory.
