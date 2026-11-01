# Publish the reviewed Ribbon browsing catalog

This operation only changes `isActive` and `updatedAt` on the selected catalog
and its 392 existing color entries. It creates no collections or indexes.

Inspect the current records and save a before-state backup:

```sh
node operations/publish-shop-ribbon-catalog.mjs <catalog-id>
```

Apply the exact successful preview fingerprint:

```sh
node operations/publish-shop-ribbon-catalog.mjs <catalog-id> --apply --expect-sha=<preview-sha256>
```

The script requires `production-db`, exactly one reviewed Ribbon/color-grid
catalog, two active materials, 196 unique colors per material, four complete
49-position pages each, and matching active/requestable source variations,
labels, and image URLs. Display spacing in color labels is normalized.

A single transaction rechecks the complete fingerprint and activates all
entries and the catalog together. Changed metadata, a stale fingerprint, or a
partially published catalog aborts the operation. A fully published catalog
requires no updates. After commit, verification confirms that only visibility
and update timestamps changed and all 392 entries are active.

Before/after records and the result, including actual write collections, are
saved under `/Users/azad/Backups/megadie/shop-catalog-publish-*`. A report with
`committed: true` indicates that the transaction committed even if a later
verification or report write failed; rerun a read-only preview to reconcile.

Publication changes database visibility. Application deployment is a separate
release step. Customers and admins use the same published-catalog API.
