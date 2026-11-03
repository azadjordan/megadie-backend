import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import generateToken from "../utils/generateToken.js";
import { ADMIN_SESSION_SECONDS, CUSTOMER_SESSION_SECONDS, getSessionExpiry } from "../utils/sessionPolicy.js";

const now = Math.floor(Date.now() / 1000);
test("admin expiry caps old 30-day tokens using the current database role", () => {
  const old = { iat: now - 60, exp: now + CUSTOMER_SESSION_SECONDS };
  assert.equal(getSessionExpiry(old, { isAdmin: true }, now), old.iat + 1200);
  assert.equal(getSessionExpiry(old, { isAdmin: false }, now), old.exp);
  assert.equal(getSessionExpiry({ ...old, exp: now + 5 }, { isAdmin: true }, now), now + 5);
  for (const iat of [undefined, null, "123", now + 1, 0, -1, 1.5]) {
    assert.throws(() => getSessionExpiry({ ...old, iat }, { isAdmin: true }, now));
  }
});

test("token and cookie lifetimes match the trusted user's role", (t) => {
  const secret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "session-unit-test-secret";
  t.after(() => { if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret; });
  for (const isAdmin of [true, false]) {
    let cookie;
    const metadata = generateToken({ cookie: (...args) => { cookie = args; } }, { _id: "user", isAdmin });
    const decoded = jwt.verify(cookie[1], process.env.JWT_SECRET);
    const duration = isAdmin ? ADMIN_SESSION_SECONDS : CUSTOMER_SESSION_SECONDS;
    assert.equal(decoded.exp - decoded.iat, duration);
    assert.equal(cookie[0], "jwt");
    assert.equal(cookie[2].maxAge, duration * 1000);
    assert.equal(cookie[2].httpOnly, true);
    assert.equal(metadata.sessionExpiresAt, decoded.exp * 1000);
    assert.ok(Math.abs(metadata.sessionServerTime - Date.now()) < 1000);
  }
});
