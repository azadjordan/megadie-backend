# Import the Ribbon browsing catalog

This is separate from `create-ribbon-catalog.mjs`, which creates sellable products.
This importer creates only one inactive `Catalog` and 392 inactive `CatalogEntry`
records (196 Grosgrain, 196 Satin). It never changes products, prices, stock,
reservations, or the frontend.

Preview using the reviewed `entries.json` from the catalog-entry audit:

```sh
node operations/import-shop-ribbon-catalog.mjs /absolute/path/to/entries.json
```

Apply the same file using the SHA256 printed by the preview:

```sh
node operations/import-shop-ribbon-catalog.mjs /absolute/path/to/entries.json --apply --expect-sha=<preview-sha256>
```

The importer validates both schemas, active material/category references,
unique codes, and current source products restricted to Ribbon, 1 inch, A+,
100yd Roll. Labels and image URLs must still match those products. Codes are
sorted numerically within each material and assigned four pages of 49 entries.
The audit's suggested positions are not used.

Apply creates the catalog models' unique indexes and inserts the catalog and
entries together in a transaction. It rechecks source metadata in the transaction
and verifies saved records afterward. An exact existing inactive catalog is
skipped; conflicting, published, or incomplete catalog data causes an error.
It does not repair or overwrite existing catalog records.

Uses backend `.env`, requires `production-db`, and disables automatic collection
and index creation during preview. Reports, before-state, and the proposed
manifest are saved under `/Users/azad/Backups/megadie/shop-catalog-*`.
If execution is interrupted or verification fails, inspect the report and rerun
preview to reconcile the database before retrying. Indexes may remain after a
failed insertion. No stock/availability values are stored in the catalog.

The importer leaves records inactive. After review, use the separate
[publication operation](publish-shop-ribbon-catalog.README.md) to activate the
catalog and entries together. Shop APIs only read active records. Re-running
this importer against a published catalog is refused.
