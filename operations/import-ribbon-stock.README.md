# Import the AE1 Ribbon physical count

Run read-only reconciliation first:

```sh
node operations/preview-ribbon-stock.mjs
```

Then run the importer in dry-run mode using the resulting preview directory:

```sh
node operations/import-ribbon-stock.mjs /absolute/path/to/ribbon-stock-preview-...
```

Apply requires the exact CSV SHA-256 and total quantity shown by the reviewed preview:

```sh
node operations/import-ribbon-stock.mjs /absolute/path/to/ribbon-stock-preview-... --apply --expect-sha256=HASH --expect-qty=COUNT
```

The script reads the current CSV bytes and compares the hash, validates the plan and checks all relevant production collections against the preview snapshot. If anything changed, run reconciliation again. A batch ID based on the CSV hash prevents a second import of that count. It creates one slot item and one ADJUST_IN movement per matched product and AE1 location, then recalculates occupied CBM for affected slots using the preview's complete contents. All writes are in one transaction. After commit, it verifies item/movement totals, affected occupancy, and protected inventory.

Accepted capacity warnings do not change quantities. It never clears inventory or touches A/B/C, FLOOR, other stores, other product types, reservations, or products. A database transaction can fail or have an uncertain outcome after a connection loss; inspect the local result and rerun reconciliation before considering any retry.

Reports are saved under /Users/azad/Backups/megadie/ribbon-stock-import-*. This operations script is local until explicitly committed. Production credentials remain in backend .env and are not printed.
