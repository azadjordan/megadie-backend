import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import generateToken from "../utils/generateToken.js";
import AdminSession from "../models/adminSessionModel.js";
import { ADMIN_SESSION_SECONDS, ADMIN_IDLE_SECONDS, CUSTOMER_SESSION_SECONDS, getSessionExpiry } from "../utils/sessionPolicy.js";

const now = Math.floor(Date.now() / 1000);
const sessionId = "a".repeat(64);
const payload = { sessionId, iat: now, exp: now + ADMIN_SESSION_SECONDS };
const session = { _id: sessionId, user: "user", startedAt: new Date(now * 1000), idleExpiresAt: new Date((now + ADMIN_IDLE_SECONDS) * 1000), absoluteExpiresAt: new Date((now + ADMIN_SESSION_SECONDS) * 1000) };
const admin = { _id: "user", isAdmin: true };

test("admin deadlines enforce inactivity, absolute duration, token expiry, ownership and revocation", () => {
  assert.equal(getSessionExpiry(payload, admin, now, session), now + 1800);
  assert.equal(getSessionExpiry(payload, admin, now, { ...session, idleExpiresAt: new Date((now + 999999) * 1000), absoluteExpiresAt: new Date((now + 999999) * 1000) }), now + 28800);
  assert.equal(getSessionExpiry({ ...payload, exp: now + 10 }, admin, now, session), now + 10);
  for (const record of [null, { ...session, revokedAt: new Date() }, { ...session, user: "someone-else" }, { ...session, idleExpiresAt: "bad" }, { ...session, startedAt: new Date(0) }]) assert.throws(() => getSessionExpiry(payload, admin, now, record));
  for (const iat of [undefined, null, "123", now + 1, 0, -1, 1.5]) assert.throws(() => getSessionExpiry({ ...payload, iat }, admin, now, session));
  assert.throws(() => getSessionExpiry({ ...payload, sessionId: undefined }, admin, now, session));
});

test("legacy admins and promoted customer tokens require fresh sign-in; customer lifetime is unchanged", () => {
  const old = { iat: now - 60, exp: now + CUSTOMER_SESSION_SECONDS };
  assert.equal(getSessionExpiry(old, { isAdmin: false }, now), old.exp);
  assert.throws(() => getSessionExpiry(old, admin, now));
  assert.throws(() => getSessionExpiry(payload, { _id: "user", isAdmin: false }, now, session));
});

test("tokens/cookies cap at eight hours while initial admin metadata expires after 30 idle minutes", async (t) => {
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "session-unit-test-secret";
  t.after(() => { if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous; });
  t.mock.method(AdminSession, "create", async (record) => record);
  for (const isAdmin of [true, false]) {
    let cookie;
    const metadata = await generateToken({ cookie: (...args) => { cookie = args; } }, { _id: "user", isAdmin });
    const decoded = jwt.verify(cookie[1], process.env.JWT_SECRET);
    const duration = isAdmin ? ADMIN_SESSION_SECONDS : CUSTOMER_SESSION_SECONDS;
    assert.equal(decoded.exp - decoded.iat, duration);
    assert.equal(cookie[2].maxAge, duration * 1000);
    assert.equal(cookie[2].httpOnly, true);
    assert.equal(metadata.sessionExpiresAt, (decoded.iat + (isAdmin ? ADMIN_IDLE_SECONDS : duration)) * 1000);
    if (isAdmin) {
      assert.match(decoded.sessionId, /^[a-f0-9]{64}$/);
      assert.equal(metadata.sessionId, decoded.sessionId);
      assert.equal(metadata.sessionAbsoluteExpiresAt, decoded.exp * 1000);
    } else assert.equal(metadata.sessionId, undefined);
  }
});
