# Discontinued paper-core double-face tape

On 17 November 2026, the owner discontinued Paper Core double-face tape. The three unreferenced Paper-category products were backed up and deleted together from the configured production database:

- `DFT|PAP|6-MM|PPC|50M-ROLL`
- `DFT|PAP|9-MM|PPC|50M-ROLL`
- `DFT|PAP|12-MM|PPC|50M-ROLL`

The cleanup checked stock, allocations, inventory movements, current/historical order items and quotes before deleting. It then verified that the six remaining tape products, three shared price rules, categories, filter configuration and customer prices matched their pre-deletion records. The three Paper pricing rules stay because the Plastic Core products still use them. The Paper category stays for the same reason. Product images were not deleted from object storage.

Recovery records and their checksum are stored outside both repositories and the preview server under the workspace's `.local-backups/paper-core-tape-retirement-2026-11-17/` directory. They contain full Extended JSON product records and the preservation checks. No customer orders or inventory records were deleted.

The backend product schema and preview reject Paper Core for Double Face Tape, using the category's actual product type. Product metadata exposes per-type variant choices. Create/edit screens filter tape choices to Plastic Core, including older cached metadata, and selecting the tape type defaults to Plastic Core. Global variants remain available for other product types. Existing tape records with no specified core are preserved rather than relabelled.

Verification: `tests/product-variant-policy.integration.mjs` uses a guarded disposable local database for preview/create/update rejection, type spoofing, allowed plastic variants, unspecified legacy cores, unaffected other types and shared pricing. `tests/product-variant-policy.browser.mjs` intercepts all APIs and checks both editors and switching types. Frontend lint/build also pass.

The data deletion is already live. Deploy backend and frontend changes to enforce the product-entry restriction on the deployed website. No schema migration is needed.
