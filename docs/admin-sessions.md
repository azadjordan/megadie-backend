# Admin sessions

Admins have a 30-minute inactivity deadline and an eight-hour absolute lifetime.
Typing, clicking, wheel scrolling, keyboard navigation and touch in a visible
page report activity at most once per minute per tab. Page loads, focus checks,
profile edits and background API reads do not renew a session. Customers keep
their existing 30-day cookie/token policy.

## Server policy

Admin login and password-reset sign-in create an AdminSession record and an
eight-hour HTTP-only JWT cookie. The signed token identifies a random server
session. Each protected request checks the current database role, session owner,
revocation, inactivity deadline, token expiry and absolute login-time cap.
Legacy admin tokens without a session record require a new sign-in. Customer
tokens cannot retain their longer privileges after promotion to admin.

The session record stores only its random id, user, start/activity times,
deadlines and revocation time. An absolute-expiry TTL index cleans up records;
authentication never relies on asynchronous TTL deletion.

`POST /api/users/session/activity` requires admin authentication, a trusted
Origin and the matching `sessionId` in its JSON body. It is rate limited.
Conditional, monotonic updates prevent concurrent requests from shortening the
deadline or reviving an expired/revoked session. All times come from the server;
client-supplied deadlines/timestamps are ignored. Renewal never changes the
cookie or absolute login deadline.

Profile responses and activity acknowledgments expose `sessionId`,
`sessionExpiresAt`, `sessionAbsoluteExpiresAt` and `sessionServerTime`. Only these
server responses update the UI's deadlines. Database outages remain server
errors rather than being misreported as invalid authentication.

Admin logout requires a trusted Origin and the current session id, then revokes
that session immediately. It does not delete the shared cookie in its response:
a delayed response must not erase a newer login. The retained cookie refers to
a revoked session and cannot authorize requests; a subsequent login replaces it.
Password resets, admin password changes and role changes revoke existing admin
sessions. A separate login on another device has its own session record.

## UI behavior

A nonblocking warning appears two minutes before inactivity expiry, with a
countdown and **Stay signed in**. Successful renewal updates auth metadata only;
it does not navigate, unmount forms or reset business-data caches. Near the
eight-hour cap, the warning asks the admin to save and sign in again instead.
Network failures leave deadlines unchanged and provide a retry. Returning after
sleep/focus checks the server, including when a local deadline may be stale.

Tabs exchange scoped login/logout/renewal hints using BroadcastChannel with a
storage fallback. Renewal hints trigger a server read, never trusted local
deadline changes. Login/bootstrap/profile updates have separate paths. Session
generations discard delayed responses from previous identities, and bootstrap
uses current query data rather than retained results from an older session.
Expiry clears local admin identity/caches; it sends no delayed logout request.

## Verification and rollout

```sh
node --test tests/admin-session.test.mjs
AUTH_TEST_URI='mongodb://127.0.0.1:PORT/megadie_auth_test?replicaSet=NAME' node --test tests/admin-session.integration.mjs
AUTH_TEST_ORIGIN=http://localhost:5173 node --test tests/admin-session.browser.mjs
```

Integration tests accept only a named disposable local database and never load
`.env`. Browser tests intercept API traffic and simulate time. Coverage includes
active work, inactivity, the absolute cap, renewal preserving an unsaved form,
network failure, sleep, multiple tabs, revocation, password reset, legacy tokens,
and late unauthorized/logout responses after a newer login.

Deploy backend and frontend together. There is no user/order-data backfill.
Existing admins sign in once to establish the new session format. Renewing a
session preserves current form state; actual expiry still requires sign-in and
does not add general draft autosaving.
