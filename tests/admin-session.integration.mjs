// Explicit disposable local URI only. Never reads .env or the development database.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import mongoose from "mongoose";
import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import User from "../models/userModel.js";
import AdminSession from "../models/adminSessionModel.js";
import userRoutes from "../routes/userRoutes.js";
import { errorHandler } from "../middleware/errorMiddleware.js";

const uri = process.env.AUTH_TEST_URI || (process.env.AUTH_TEST_URI_FILE ? readFileSync(process.env.AUTH_TEST_URI_FILE, "utf8").trim() : "");
test("server-managed admin sessions on a disposable local database", { skip: !uri, timeout: 90000 }, async (t) => {
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\/megadie_auth_test(?:\?|$)/);
  process.env.JWT_SECRET = "local-auth-test-secret";
  process.env.NODE_ENV = "production";
  await mongoose.connect(uri, { autoIndex: false });
  t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  await mongoose.connection.dropDatabase();
  const admin = await User.create({ name: "Test Admin", email: "admin@test.invalid", phoneNumber: "admin", password: "test-password", isAdmin: true, approvalStatus: "Approved" });
  const customer = await User.create({ name: "Test Client", email: "client@test.invalid", phoneNumber: "client", password: "test-password", approvalStatus: "Approved" });
  const app = express(); app.use(express.json(), cookieParser()); app.use("/api/users", userRoutes); app.use(errorHandler);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = Math.floor(Date.now() / 1000) * 1000;
  let clock = base;
  t.mock.method(Date, "now", () => clock);
  t.beforeEach(() => { clock = base; });
  const origin = `http://127.0.0.1:${server.address().port}/api/users`;
  async function api(path, { cookie, method = "GET", body, requestOrigin = "http://localhost:5173" } = {}) {
    const headers = { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(requestOrigin ? { Origin: requestOrigin } : {}) };
    const response = await fetch(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, cookie: response.headers.get("set-cookie"), body: await response.json() };
  }
  async function login(user = admin, password = "test-password") {
    const result = await api("/auth", { method: "POST", body: { email: user.email, password, isAdmin: !user.isAdmin } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return { ...result, cookie: result.cookie.split(";")[0], metadata: result.body.data };
  }
  const activity = (auth, extra = {}) => api("/session/activity", { cookie: auth.cookie, method: "POST", body: { sessionId: auth.metadata.sessionId, ...extra } });

  await t.test("admin sign-in creates bounded server session; customers retain 30 days", async () => {
    const auth = await login();
    const decoded = jwt.verify(auth.cookie.slice(4), process.env.JWT_SECRET);
    assert.equal(decoded.exp - decoded.iat, 28800);
    assert.equal(auth.metadata.sessionExpiresAt, base + 1800000);
    assert.equal(auth.metadata.sessionAbsoluteExpiresAt, base + 28800000);
    const record = await AdminSession.findById(decoded.sessionId);
    assert.equal(String(record.user), String(admin._id));
    const client = await login(customer);
    assert.equal(jwt.verify(client.cookie.slice(4), process.env.JWT_SECRET).exp - base / 1000, 2592000);
    assert.equal(client.metadata.sessionId, undefined);
  });
  await t.test("background reads and profile edits do not renew; expiry rejects all protected operations", async () => {
    const auth = await login();
    clock += 29 * 60000;
    const read = await api("/account/profile", { cookie: auth.cookie });
    assert.equal(read.status, 200);
    assert.equal(read.body.data.sessionExpiresAt, auth.metadata.sessionExpiresAt);
    const edit = await api("/account/profile", { cookie: auth.cookie, method: "PUT", body: { name: "Edited admin" } });
    assert.equal(edit.body.data.sessionExpiresAt, auth.metadata.sessionExpiresAt);
    clock += 60000;
    for (const path of ["/account/profile", "/"]) assert.equal((await api(path, { cookie: auth.cookie })).status, 401);
    const rejected = await api("/account/profile", { cookie: auth.cookie, method: "PUT", body: { name: "Must not save" } });
    assert.equal(rejected.status, 401);
    assert.equal(rejected.cookie, null, "Late errors cannot delete a newer session cookie");
    assert.equal((await User.findById(admin._id)).name, "Edited admin");
  });
  await t.test("real activity extends the idle deadline using server time, without reissuing a cookie", async () => {
    const auth = await login();
    clock += 20 * 60000;
    const result = await activity(auth, { sessionExpiresAt: base + 99999999999, lastActivityAt: base + 99999999999 });
    assert.equal(result.status, 200);
    assert.equal(result.body.data.sessionExpiresAt, clock + 1800000);
    assert.equal(result.body.data.sessionAbsoluteExpiresAt, auth.metadata.sessionAbsoluteExpiresAt);
    assert.equal(result.cookie, null);
    clock += 20 * 60000;
    assert.equal((await api("/account/profile", { cookie: auth.cookie })).status, 200);
  });
  await t.test("expired inactivity cannot be revived", async () => {
    const auth = await login();
    clock += 30 * 60000;
    assert.equal((await activity(auth)).status, 401);
  });
  await t.test("continuous activity still stops exactly at eight hours", async () => {
    const auth = await login();
    for (let minute = 20; minute < 480; minute += 20) {
      clock = base + minute * 60000;
      const result = await activity(auth);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.ok(result.body.data.sessionExpiresAt <= base + 480 * 60000);
    }
    clock = base + 480 * 60000;
    assert.equal((await activity(auth)).status, 401);
    assert.equal((await api("/account/profile", { cookie: auth.cookie })).status, 401);
  });
  await t.test("renewal requires a trusted origin and matching session; customers cannot use it", async () => {
    const auth = await login();
    for (const requestOrigin of [null, "https://untrusted.invalid"]) {
      assert.equal((await api("/session/activity", { cookie: auth.cookie, method: "POST", body: { sessionId: auth.metadata.sessionId }, requestOrigin })).status, 403);
    }
    const mismatch = await api("/session/activity", { cookie: auth.cookie, method: "POST", body: { sessionId: "wrong" } });
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.body.code, "SESSION_CHANGED");
    const client = await login(customer);
    assert.equal((await activity(client)).status, 403);
  });
  await t.test("logout revokes just that session, including renewal, without deleting newer cookies", async () => {
    const first = await login();
    const second = await login();
    const mismatch = await api("/logout", { cookie: second.cookie, method: "POST", body: { sessionId: first.metadata.sessionId } });
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.cookie, null);
    const out = await api("/logout", { cookie: first.cookie, method: "POST", body: { sessionId: first.metadata.sessionId } });
    assert.equal(out.status, 200);
    assert.equal(out.cookie, null);
    assert.equal((await api("/account/profile", { cookie: first.cookie })).status, 401);
    assert.equal((await activity(first)).status, 401);
    assert.equal((await api("/account/profile", { cookie: second.cookie })).status, 200);
  });
  await t.test("concurrent renewal and logout cannot resurrect a revoked session", async () => {
    const auth = await login();
    clock += 60000;
    await Promise.all([activity(auth), api("/logout", { cookie: auth.cookie, method: "POST", body: { sessionId: auth.metadata.sessionId } })]);
    assert.equal((await api("/account/profile", { cookie: auth.cookie })).status, 401);
    assert.ok((await AdminSession.findById(auth.metadata.sessionId)).revokedAt);
  });
  await t.test("legacy admin tokens and promoted customer tokens require fresh sign-in", async () => {
    const old = `jwt=${jwt.sign({ userId: String(admin._id) }, process.env.JWT_SECRET, { expiresIn: "30d" })}`;
    assert.equal((await api("/account/profile", { cookie: old })).status, 401);
    const client = await login(customer);
    await User.updateOne({ _id: customer._id }, { $set: { isAdmin: true } });
    assert.equal((await api("/account/profile", { cookie: client.cookie })).status, 401);
    await User.updateOne({ _id: customer._id }, { $set: { isAdmin: false } });
  });
  await t.test("database outages are server errors, not false invalid-session responses", async (t) => {
    const auth = await login();
    t.mock.method(AdminSession, "findOne", () => { throw new Error("Injected database outage"); });
    const result = await api("/account/profile", { cookie: auth.cookie });
    assert.equal(result.status, 500);
    assert.equal(result.cookie, null);
  });
  await t.test("password reset revokes old admin sessions and creates a fresh role-specific login", async () => {
    const previous = await login();
    for (const user of [admin, customer]) {
      const raw = crypto.randomBytes(32).toString("hex");
      await User.updateOne({ _id: user._id }, { $set: { passwordResetTokenHash: crypto.createHash("sha256").update(raw).digest("hex"), passwordResetExpires: new Date(clock + 60000) } });
      const result = await api(`/reset-password/${raw}`, { method: "POST", body: { password: "new-test-password" } });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      const decoded = jwt.verify(result.cookie.split(";")[0].slice(4), process.env.JWT_SECRET);
      assert.equal(decoded.exp - decoded.iat, user.isAdmin ? 28800 : 2592000);
      assert.equal((await api("/account/profile", { cookie: result.cookie.split(";")[0] })).status, 200);
    }
    assert.equal((await api("/account/profile", { cookie: previous.cookie })).status, 401);
  });
});
