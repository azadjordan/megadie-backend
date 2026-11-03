# Fixed admin login sessions

## Behavior

Admins must sign in again 20 minutes after login, including while actively working. The UI warns two minutes before expiry. Customers keep their existing 30-day sessions. Browsing, profile edits, and page refreshes never renew the admin deadline. Login after password reset follows the same role policy.

## Backend

- `utils/sessionPolicy.js` centralizes durations, existing cookie attributes, and effective expiry. Token issuance receives the authenticated database user, never a role supplied in the request body. Admin JWT `exp` and cookie Max-Age are 1,200 seconds; customer values remain 2,592,000 seconds.
- Every protected request verifies the JWT, loads the current user as before, and caps an admin session at the signed `iat + 1,200 seconds`, even if an older token has a 30-day `exp`. An earlier token expiry still wins. Missing/invalid/future admin login times are rejected. This also prevents a promoted customer from retaining an old long-lived admin session.
- Expired/invalid sessions receive HTTP 401 and the authentication cookie is cleared with the existing HttpOnly/Secure/SameSite/path settings. Existing role and approval checks remain.
- Login and profile read/update responses include `sessionExpiresAt` and `sessionServerTime` in milliseconds. Profile responses use the token's original deadline rather than issuing a new token; the profile GET is marked no-store. Password-reset sign-in issues the same role-specific token; its following profile read supplies metadata.
- No session table, database migration, JWT-secret rotation, additional database read per request, renewal endpoint, or dependency is introduced.

## Frontend

- Auth state stores an admin deadline based on remaining server time, accounting for a workstation clock that is already incorrect at login. Profile edits within the same session preserve the existing deadline. Missing admin expiry metadata fails closed; customer state gets no admin timer.
- One `AdminSessionGuard` owns warning and expiry timers and rechecks on focus, visibility changes, and pageshow. There is no polling or activity tracking. The existing toast UI shows a persistent warning at two minutes remaining; closing the warning does not extend the session.
- At expiry, remove the warning, clear authenticated user state and RTK Query caches, and let existing route guards return the user to login with the intended destination preserved. Existing HTTP-401 handling remains a fallback. Signing in again creates a fresh deadline and fresh admin queries.
- Automatic expiry sends no logout HTTP request: the cookie/token deadline is already enforced server-side, and a delayed logout response from an older tab must not clear a newer login cookie. Explicit manual logout is unchanged.
- Background browser timer throttling is handled by checking the deadline when the tab/device returns. Backend enforcement remains authoritative if browser execution is suspended or the client clock changes.

## Release

Develop in matching `feat/admin-session-timeout` branches. Deploy the backend before the frontend. Existing admin logins older than 20 minutes are rejected on their next protected request immediately after backend deployment; newer existing logins keep only the remainder of their original 20 minutes. Customers remain signed in. An already-open old frontend gains the visible warning/timer after it loads the new build; backend enforcement applies regardless.

No Render deployment or production database mutation is performed by tests. Authentication persistence tests use an explicitly named disposable local database. Browser tests intercept all API traffic and simulate time instead of waiting 20 minutes.

## Verification

Passed: 34 backend helper/API integration/regression tests; 16 frontend session-state/formatter tests; 9 session browser tests against each of dev and compiled production builds; 17 preparation/delivery browser tests; 19 catalog browser tests against each of a fresh dev server and the production build; and the maintenance-notice browser checks. Full frontend ESLint and production build passed, with the existing bundle-size advisory unchanged. The mobile warning was visually reviewed.

Tests cover token/cookie durations, existing long-lived admin tokens, invalid/future login times, current database roles, customer promotion, password-reset sign-in, unchanged customer sessions, profile edits without renewal, client clock skew, warning/expiry with simulated time, refresh with remaining time, sleeping/mobile tabs, backend 401 fallback, fresh queries after signing in again, and missing metadata failing closed. Browser fixtures now supply the real session metadata contract. The source-inspecting catalog checks require a fresh Vite dev server; compiled catalog checks use `CATALOG_PRODUCTION_BUILD=true`.

Database mutation tests used isolated local databases only. Browser APIs were intercepted, temporary verification servers were isolated from the user's existing dev servers, and unrelated backend inventory operation files were excluded from commits.
