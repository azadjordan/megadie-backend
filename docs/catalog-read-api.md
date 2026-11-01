# Catalog read API and shopping flow

Mounted at `/api/catalogs`, using the existing JWT session cookie and shop
approval guard. Customers and admins use the same routes. Every catalog and
entry read requires `isActive: true`; admins cannot bypass publication.
Responses use `Cache-Control: private, no-store`.

## Routes

- `GET /api/catalogs?productType=Ribbon`: published catalog metadata and its
  active materials. Returns `{ success: true, data: null }` when there is no
  published catalog, so the shop can open product results directly.
- `GET /api/catalogs/:catalogId/entries?material=grosgrain&page=1`: visible
  entries on the saved physical page, ordered by page, position, and ID.
  `pagination.pages` lists actual saved pages. Hidden entries do not move other
  colors between physical pages. An out-of-range page returns an empty list.
- The same entries route with `q=red`: literal, case-insensitive substring
  search by color label/code across the selected material. Results are paged
  at 49 entries. Clearing search returns to physical-page browsing.
- `GET /api/catalogs/:catalogId/entries/:entryId`: one published entry and its
  server-generated product filters. Ribbon filters are exactly
  `{ productType: "Ribbon", categoryKeys: "grosgrain", catalogCode: "007" }`.
  No width, grade, packing, or stock restriction is added.
- `POST /api/catalogs/:catalogId/availability`, body `{ "entryIds": [...] }`:
  stock flags for up to 49 visible colors. Returns
  `{ success: true, checkedAt, data: [{ entryId, inStock, noStock }] }` without
  quantities or SKU payloads. IDs must be ObjectId strings; duplicates are
  deduplicated. Hidden, missing, cross-catalog, or invalid-category entries are
  omitted alike. Ribbon/color-grid is the supported layout.

Unauthenticated visitors get 401; accounts without shop approval get 403.
Hidden/missing catalogs and single entries return 404. Invalid IDs, product
types, materials, scalar query values, page numbers, and searches over 100
characters return 400. Unsupported selection/availability layouts return 422.

The old `/api/catalogs/preview` routes have no handlers. Query flags such as
`preview=true` and `isActive=false` cannot change visibility.

## Customer flow

Product-type cards open `/shop/catalog/:productType`, behind login and shop
approval. Only the selected type makes a cached catalog lookup; the entrance
does not request every catalog. A published Ribbon/color-grid catalog opens
the color browser. An absent, inactive, or unsupported catalog opens existing
product results using replacement navigation, so browser Back returns to the
product-type entrance. Lookup failures offer retry and View All.

Existing `/shop?productType=...` and filtered product URLs continue to open
products directly. The current catalog UI uses one lazy-loaded bundle.
Material tabs, search, and the separate View All control keep that order.

Choosing a color uses the filters already loaded with the page, through
`/shop/catalog/Ribbon/:catalogId/:entryId`, without another entry request.
Direct/new-tab selection URLs use the published-only single-entry API.
Selection replaces itself with `/shop` and adds only the product type,
material key, and catalog code to product filters. Every matching variation
remains available to the existing product filters and cart.

Material, browse page, search text, and search page are preserved in catalog
return state, including while filtering, paginating, or refreshing products.
Shared scroll restoration restores the saved position after content loads.
Selected code, color name, and material supply the product-results heading.
View All bypasses color filtering and keeps the catalog return link.
Copying a product-results URL opens normal results; optional catalog return
context belongs to its original browser history entry.

There is no admin preview UI, badge, navigation mode, or API branch. Retired
`/__preview/ribbon-catalog` URLs return not found. Old product history ignores
its preview mode and returns to the published catalog. A cached selected-entry
payload marked as preview is revalidated through the published-only API.

The entrance, catalog, and product results use `ShopHeader`: desktop breadcrumbs
and a mobile parent link share consistent placement. Image slots reserve their
dimensions; the first images load eagerly and the others use native lazy loading.

## Availability and performance

Availability matches active, requestable products by exact category/material
and catalog code, across all widths, grades, and packaging. `inStock` requires
at least one variation with stock meeting its MOQ. `noStock` means no matching
requestable variation has a positive available balance, including colors with
no such variation. Positive stock below MOQ leaves both flags false.

The catalog independently loads one stock batch for visible colors. Green
“In stock” and neutral gray “No stock” badges sit at the image top left. All
colors remain visible and clickable. Loading/errors show neither badge and
do not block browsing or shift tile dimensions. A shared note explains that
stock varies by width and grade.

`getAvailabilityTotalsByProduct` supplies on-hand stock minus active order
reservations, clamped at zero. One product lookup and one stock/reservation
aggregation pair serve the page; there is no read per tile. Empty product sets
skip aggregations. No stock totals are stored in catalog records or a server
cache. Quote/order validation still reads fresh stock outside browsing caches.

Shop and cart share `useProductAvailability`. Deduplicated, sorted IDs reuse
the same RTK Query cache key regardless of display order. Product details use
the same freshness policy: refresh on revisits after 15 seconds, focus, and
reconnection. This is not polling. Unused stock responses keep RTK Query's
60-second default lifetime, while catalog metadata/pages use five minutes.
Inventory, reservation, and order invalidation tags refresh displayed stock.
Different endpoints and different ID sets keep separate query-cache entries.

The product availability endpoint retains exact quantities and also returns
`inStock`. Both stock endpoints provide `Server-Timing: availability;dur=...`.

## Publication and release

Catalog model auto-index/collection creation is disabled; explicit provisioning
handles indexes. The guarded
[publication operation](../operations/publish-shop-ribbon-catalog.README.md)
activated the Ribbon catalog and all 392 color entries on 1 November 2026.
Inventory and product data were unchanged.

The read-only review verified 196 colors per material, four pages of 49 each,
valid category/code mappings, and requestable variations for every color. All
392 image URLs were verified. Labels matched exactly for 172 entries and after
normalizing display spacing for the other 220.

The [preview removal plan](admin-catalog-preview-removal-plan.md) is implemented.
Application deployment is performed manually after the repository changes are
committed and pushed; database publication alone does not deploy application code.

## Verification

From the backend directory:

```sh
node --test tests/catalog.test.mjs tests/catalog-availability.test.mjs operations/ribbon-catalog-safety.test.mjs
CATALOG_TEST_SCREENSHOTS=/tmp/catalog-checks node --test tests/catalog-shopping.e2e.mjs
```

The browser suite requires the frontend dev server at `http://localhost:5173`.
Override it with `CATALOG_TEST_ORIGIN`. API and browser fixtures do not connect
to MongoDB, submit quotes, or write live inventory. Checks cover access,
publication, material isolation, literal search, filters, pagination, stock/MOQ,
navigation, cart, mobile layout, keyboard focus, and retired preview paths/state.

Build the frontend and start Vite preview on port 4173 to check compiled assets:

```sh
CATALOG_PRODUCTION_BUILD=true CATALOG_TEST_ORIGIN=http://127.0.0.1:4173 node --test tests/catalog-shopping.e2e.mjs
```

Dev-only store-invalidation probes remain in the development run. Production
checks still verify stock refresh through focus, reconnect, and revisit events.
