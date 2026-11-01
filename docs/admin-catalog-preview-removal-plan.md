# Plan to remove the admin catalog preview

Status: implemented locally. Preview routes, UI, and API branches are removed.
Application deployment will be performed manually on Render after the changes
are committed and pushed to `main` in both repositories.

The goal is one published-catalog shopping flow for customers and admins, with
the existing catalog and entry publication controls retained.

## Sequence

1. Completed: publish the reviewed Ribbon catalog and its 392 existing color entries.
2. Completed: review this plan and remove the preview while retaining the
   shared published-catalog flow for customers and admins.
3. Verify the acceptance checks below, commit the catalog changes, merge into
   `main`, and push both repositories.
4. Manually deploy the backend and frontend on Render. Database publication
   does not deploy application code.

## Frontend changes

- `src/routes/AppRoutes.jsx`: remove both `/__preview/ribbon-catalog` routes
  and their admin-only wrapper. Keep both `/shop/catalog/:productType` routes
  behind login and shop approval.
- `src/components/shop/ShopEntrance.jsx`: remove the development/admin Ribbon
  shortcut. Every product-type card uses the normal catalog lookup and its
  direct-to-products fallback.
- `src/features/catalogs/catalogsApiSlice.js`: always use `/catalogs`; remove
  the preview argument, endpoint branch, and separate preview cache keys.
- `src/pages/Public/CatalogPage.jsx` and `RibbonCatalogSelectionPage.jsx`:
  remove preview props and UI branches. Keep cached selection reuse, direct
  entry lookup, retry states, and publication checks through the normal API.
- `src/utils/ribbonCatalogNavigation.js` and `src/pages/Public/ShopPage.jsx`:
  remove preview paths and access-mode state. Return links always point to the
  customer catalog and preserve material, page, search, and scroll position.
- `src/components/shop/ShopHeader.jsx` and `src/components/layout/Header.jsx`:
  remove the preview badge/prop and preview-only active-navigation handling.

Keep the current visual design, Material → Search → View All ordering, stock
badges, product filters, cart behavior, and browsing cache policy.

## Backend changes

- `routes/catalogRoutes.js`: remove the preview router and its mode-setting
  middleware. Keep authentication, shop approval, and private/no-store responses.
- `controllers/catalogController.js`: remove the `req.catalogPreview` visibility
  branch. Every catalog and entry read requires `isActive: true`, including
  requests by admins. Keep category validation, material/code mapping, and
  batched availability calculations.
- Keep the `Catalog` and `CatalogEntry` models and their `isActive` fields.
  Removing preview must not publish other records or alter products, inventory,
  prices, reservations, or orders.

## Existing links and browser history

The old development preview URLs can return not found; the normal replacement
is `/shop/catalog/Ribbon`. No compatibility preview API is needed.

Existing product-page history may contain `ribbonCatalogPreview`. Ignore that
mode and build its catalog return link using the normal customer route. A
saved selected-entry payload explicitly marked as preview must be revalidated
through the published-only API before reuse. Do not turn old preview state into
permission to display inactive entries.

## Acceptance checks

- Approved customers and admins follow the same published catalog flow.
- Pending/rejected accounts and unauthenticated visitors retain existing access
  restrictions. Inactive catalogs and entries remain hidden for every viewer.
- Both old preview API routes and frontend URLs are unavailable; query flags
  cannot enable preview or bypass publication.
- Product types without a published supported catalog still open products
  directly, without a browser Back loop. Existing filtered product URLs work.
- Search, material/page changes, color links opened in a new tab, View All,
  filters, refresh, browser navigation, scroll restoration, and cart additions
  work on desktop and small mobile screens.
- Stock uses one batch for visible colors, keeps MOQ/zero-stock distinctions,
  and handles loading/errors, focus/reconnect, and inventory invalidation.
- Update the existing API/browser tests to use published fixtures and replace
  preview-flow coverage with assertions that preview access no longer exists.
  Run build, targeted lint, API checks, and the customer browser suite against
  both development and compiled production assets.

## Rollback

Keep the removal in a focused change with a before-state copy of the affected
files. If it needs reverting, restore only the preview-removal changes. The
published catalog and customer integration can remain in place.

## Publication record

Published on 1 November 2026: catalog `6ad13f7f6b26083fcf4b78a2` and all 392
color entries are active. The transaction committed and verification confirmed
that only `isActive` and `updatedAt` changed. The database write log contains
only `catalogentries` and `catalogs` updates.

The publication report, fingerprint, and before/after records are saved locally
under `/Users/azad/Backups/megadie/shop-catalog-publish-apply-2026-11-01T13-17-31.402Z`.
The later preview-removal change does not modify the published database records.
