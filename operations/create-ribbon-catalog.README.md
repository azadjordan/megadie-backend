# Create missing A+ ribbon products

Preview (no database writes):

```sh
node operations/create-ribbon-catalog.mjs /absolute/path/to/proposed.json
```

After reviewing that preview, apply explicitly:

```sh
node operations/create-ribbon-catalog.mjs /absolute/path/to/proposed.json --apply --expect-count=819
```

Use the count from the current preview, not this example, if it changes.

Input is proposed.json from audit-ribbon-catalog.mjs. The script restricts material, code format, sizes, grade, packaging, image host/path and CBM. It rechecks pricing, categories, existing variations, SKUs, model validation and image URLs. Exact existing products are skipped; conflicting records abort. All candidates are validated before a transaction inserts them together. The insert uses already validated/generated model documents and explicitly supplies timestamps. No inventory collections are written.

Products are active and available, MOQ 1, not featured. Zero stock may display Maybe Available. Existing products and visibility settings are not changed.

Reports, including preflight product/category/rule records, are stored outside the repository under /Users/azad/Backups/megadie/ribbon-catalog-preview-* or ribbon-catalog-apply-*. Keep these local. plan.json is written before applying, result.json records completion or failure. If committed is true but verification fails, inspect created IDs before taking further action; committed changes are not automatically undone. A process/network failure can leave commit outcome uncertain: rerun preview to reconcile rather than assuming failure means nothing was created.

Uses backend .env and requires database production-db. Automatic index/collection creation is disabled. Run preview with read-only credentials when possible. Do not run concurrent catalog maintenance while applying. Existing default and customer-specific pricing rules are reused; no pricing changes are made.

Sanity checks: `node --test operations/ribbon-catalog-safety.test.mjs`. These cover command-line gating, exact image identity (including the 435 spelling exception), mandatory unique SKU index, parallel failure cleanup, and transient image retries. Image checks retry network/temporary HTTP failures at most three times; permanent HTTP failures and non-image responses remain blockers. Apply requests snapshot reads and majority write acknowledgment. Live preview/rejection checks do not exercise actual transaction commit/rollback.
