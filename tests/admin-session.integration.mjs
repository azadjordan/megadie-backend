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
import userRoutes from "../routes/userRoutes.js";
import { errorHandler } from "../middleware/errorMiddleware.js";

const uri = process.env.AUTH_TEST_URI_FILE ? readFileSync(process.env.AUTH_TEST_URI_FILE, "utf8").trim() : "";
test("admin session API on an isolated local database", { skip: !uri, timeout: 90000 }, async (t) => {
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
  const origin = `http://127.0.0.1:${server.address().port}/api/users`;
  async function api(path, { cookie, method = "GET", body } = {}) {
    const response = await fetch(origin + path, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, cacheControl: response.headers.get("cache-control"), cookie: response.headers.get("set-cookie"), body: await response.json() };
  }
  const token = (user, claims = {}, options = {}) => `jwt=${jwt.sign({ userId: String(user._id), ...claims }, process.env.JWT_SECRET, { expiresIn: "30d", ...options })}`;
  const now = Math.floor(Date.now() / 1000);
  await t.test("real login issues admin 20-minute and customer 30-day cookies", async () => {
    for (const user of [admin, customer]) {
      const result = await api("/auth", { method: "POST", body: { email: user.email, password: "test-password", isAdmin: !user.isAdmin } });
      assert.equal(result.status, 200);
      const cookie = result.cookie.split(";")[0];
      const decoded = jwt.verify(cookie.slice(4), process.env.JWT_SECRET);
      const seconds = user.isAdmin ? 1200 : 2592000;
      assert.equal(decoded.exp - decoded.iat, seconds);
      assert.match(result.cookie, new RegExp(`Max-Age=${seconds}(?:;|$)`));
      assert.match(result.cookie, /HttpOnly/); assert.match(result.cookie, /Secure/); assert.match(result.cookie, /SameSite=None/);
      assert.equal(result.body.data.sessionExpiresAt, decoded.exp * 1000);
      const profile = await api("/account/profile", { cookie });
      assert.equal(profile.status, 200);
      assert.equal(profile.cacheControl, "no-store");
      assert.equal(profile.body.data.sessionExpiresAt, decoded.exp * 1000);
    }
  });
  await t.test("legacy admin sessions expire exactly at 20 minutes on all protected reads and edits", async () => {
    const valid = token(admin, { iat: now - 1190 });
    const profile = await api("/account/profile", { cookie: valid });
    assert.equal(profile.status, 200);
    assert.equal(profile.body.data.sessionExpiresAt, (now + 10) * 1000);
    const edit = await api("/account/profile", { cookie: valid, method: "PUT", body: { name: "Edited admin" } });
    assert.equal(edit.status, 200);
    assert.equal(edit.body.data.sessionExpiresAt, profile.body.data.sessionExpiresAt);
    assert.equal(edit.cookie, null, "Profile edits do not reissue a cookie");
    const expired = token(admin, { iat: now - 1200 });
    for (const path of ["/account/profile", "/"]) {
      const result = await api(path, { cookie: expired });
      assert.equal(result.status, 401);
      assert.match(result.cookie, /jwt=;/);
    }
    assert.equal((await api("/account/profile", { cookie: expired, method: "PUT", body: { name: "Must not save" } })).status, 401);
    assert.equal((await User.findById(admin._id)).name, "Edited admin");
    assert.equal((await api("/account/profile", { cookie: token(admin, {}, { noTimestamp: true }) })).status, 401);
    assert.equal((await api("/account/profile", { cookie: token(admin, { iat: now + 60 }) })).status, 401);
  });
  await t.test("customer tokens retain their lifetime and promotion cannot retain a long admin session", async () => {
    const old = token(customer, { iat: now - 86400 });
    assert.equal((await api("/account/profile", { cookie: old })).status, 200);
    assert.equal((await api("/account/profile", { cookie: token(customer, { iat: now - 2592000 }) })).status, 401);
    await User.updateOne({ _id: customer._id }, { $set: { isAdmin: true } });
    assert.equal((await api("/account/profile", { cookie: old })).status, 401);
    await User.updateOne({ _id: customer._id }, { $set: { isAdmin: false } });
  });
  await t.test("password-reset auto-login uses the same role-specific lifetime", async () => {
    for (const user of [admin, customer]) {
      const raw = crypto.randomBytes(32).toString("hex");
      await User.updateOne({ _id: user._id }, { $set: { passwordResetTokenHash: crypto.createHash("sha256").update(raw).digest("hex"), passwordResetExpires: new Date(Date.now() + 60000) } });
      const result = await api(`/reset-password/${raw}`, { method: "POST", body: { password: "new-test-password" } });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      const cookie = result.cookie.split(";")[0];
      const decoded = jwt.verify(cookie.slice(4), process.env.JWT_SECRET);
      assert.equal(decoded.exp - decoded.iat, user.isAdmin ? 1200 : 2592000);
      const read = await api("/account/profile", { cookie });
      assert.equal(read.status, 200);
      assert.equal(read.body.data.sessionExpiresAt, decoded.exp * 1000);
    }
    assert.equal((await api("/logout", { method: "POST" })).status, 200);
    assert.equal((await api("/account/profile")).status, 401);
  });
});
