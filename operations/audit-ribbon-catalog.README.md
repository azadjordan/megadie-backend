# Ribbon catalog audit

Run from the backend directory:

```sh
node operations/audit-ribbon-catalog.mjs
```

Optional positional arguments: photos root directory, output directory. Quote paths containing spaces.

Reads MONGO_URI from the backend .env without printing credentials. Uses find/listIndexes and unsaved model validation only; automatic index/collection creation is disabled. It does not start the server or have an apply mode. Prefer read-only database credentials for server-enforced permissions. Command monitoring detects unexpected commands; it is not a substitute for database permissions.

Default report location: /Users/azad/Backups/megadie/ribbon-catalog-audit-<timestamp>.

Outputs summary.txt, summary.json, proposed-products.csv, proposed.json, issues.json and images.json. Ready means current checks passed, not authorization to create. Missing allowed codes remain blockers until the backend is updated and deployed. Satin 435 uses the approved display name Thistle; its original Thristle image filename is preserved. HTTP failures may be temporary and remain unverified rather than being classified as missing objects.

Existing records are compared but never corrected. No inventory records are written. Visibility defaults are proposals: active, available, not featured, MOQ 1. Products without stock may appear as Maybe Available. Customer prices reuse existing price rules. No customer identifiers are exported.

Reads are not a point-in-time database snapshot. Run again before creation; the source fingerprint identifies the database data used by this report but is not a transaction guarantee.
