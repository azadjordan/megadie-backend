// All API traffic is intercepted. Clock advances simulate hours without waiting.
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const origin = process.env.AUTH_TEST_ORIGIN || "http://localhost:5173";
const minute = 60000;
const search = "Search by user name, email, or order #";

test("activity-based admin session browser flow", { timeout: 180000 }, async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const run = (name, fn) => t.test(name, { skip: process.env.AUTH_TEST_CASE && !name.includes(process.env.AUTH_TEST_CASE) }, fn);
  async function fixture(t, { admin = true, signedIn = true, missingMetadata = false, mobile = false } = {}) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1400, height: 1000 } });
    t.after(() => context.close());
    const start = Date.now();
    const state = { now: start, expiresAt: start + (admin ? 30 * minute : 30 * 24 * 60 * minute), absoluteAt: start + 480 * minute, sessionId: "session-1", sequence: 1, signedIn, requests: [], errors: [], rejectProtected: false };
    const profile = () => ({ _id: "fixture-user", name: admin ? `Session Test Admin ${state.sessionId}` : "Session Test Client", email: "session@test.invalid", phoneNumber: "TEST-PHONE", isAdmin: admin, approvalStatus: "Approved",
      ...(missingMetadata ? {} : { sessionExpiresAt: state.expiresAt, sessionServerTime: state.now, ...(admin ? { sessionId: state.sessionId, sessionAbsoluteExpiresAt: state.absoluteAt } : {}) }) });
    await context.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (!url.pathname.startsWith("/api/")) return url.origin === origin ? route.continue() : route.abort();
      const path = url.pathname.slice(4), method = request.method();
      if (method === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,PUT,OPTIONS" } });
      state.requests.push({ path, method, now: state.now });
      const headers = { "access-control-allow-origin": origin, "access-control-allow-credentials": "true" };
      const reply = (body, status = 200) => route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify(body) });
      if (path === "/site-settings/maintenance-notice") return reply({ data: { enabled: false } });
      if (path === "/users/auth" && method === "POST") {
        state.signedIn = true;
        state.sessionId = `session-${++state.sequence}`;
        state.absoluteAt = state.now + 480 * minute;
        state.expiresAt = state.now + (admin ? 30 * minute : 30 * 24 * 60 * minute);
        return reply({ data: profile() });
      }
      if (path === "/users/logout" && method === "POST") {
        const captured = state.sessionId;
        if (state.holdLogout) { state.holdLogout = false; await new Promise((resolve) => { state.finishLogout = resolve; }); }
        if (captured === state.sessionId) state.signedIn = false;
        return reply({ success: true });
      }
      if (path === "/users" && state.holdUsers) {
        state.holdUsers = false;
        await new Promise((resolve) => { state.finishUsers = resolve; });
        return reply({ message: "Old session expired" }, 401);
      }
      if (!state.signedIn || state.now >= state.expiresAt || state.rejectProtected) return reply({ message: "Session expired or invalid. Please sign in again." }, 401);
      if (path === "/users/session/activity") {
        if (state.failActivity) return route.abort("failed");
        if (request.postDataJSON().sessionId !== state.sessionId) return reply({ code: "SESSION_CHANGED" }, 409);
        state.expiresAt = Math.min(state.now + 30 * minute, state.absoluteAt);
        return reply({ data: profile() });
      }
      if (path === "/users/account/profile") return state.failProfile ? route.abort("failed") : reply({ data: profile() });
      if (path === "/orders/work-summary") return reply({ data: {} });
      if (path === "/orders") return reply({ data: [], pagination: { page: 1, total: 0, totalPages: 1, limit: 20 } });
      return reply({ data: [] });
    });
    const pages = [];
    async function newPage(path = admin ? "/admin/orders" : "/account/profile") {
      const page = await context.newPage();
      pages.push(page);
      page.setDefaultTimeout(8000);
      await page.clock.install({ time: new Date(state.now) });
      page.on("pageerror", (error) => state.errors.push(error.message));
      await page.goto(origin + path);
      return page;
    }
    const page = await newPage();
    const settle = () => Promise.all(pages.map((p) => p.clock.runFor(50)));
    const advance = async (ms) => { await settle(); state.now += ms; await Promise.all(pages.map((p) => p.clock.fastForward(ms))); await settle(); };
    const login = async (target = page) => {
      await target.locator('input[type="email"]').fill("session@test.invalid");
      await target.locator('input[type="password"]').fill("test-password");
      await target.getByRole("button", { name: "Sign in", exact: true }).click();
      await target.waitForURL("**/admin/orders");
    };
    const activityCount = () => state.requests.filter((r) => r.path === "/users/session/activity").length;
    if (signedIn && !missingMetadata) await page.getByText(admin ? "Track orders created from quotes and manage fulfillment." : "Keep your contact details up to date.", { exact: true }).waitFor();
    t.after(() => assert.deepEqual(state.errors, []));
    return { page, state, start, advance, login, newPage, activityCount };
  }

  await run("idle warning at 28 minutes and expiry at 30; focus and reload do not renew", async (t) => {
    const { page, state, start, advance, activityCount } = await fixture(t);
    await advance(15 * minute);
    await page.reload();
    await page.getByPlaceholder(search).waitFor();
    await advance(13 * minute + 100);
    await page.getByRole("region", { name: "Admin session warning" }).waitFor();
    await page.screenshot({ path: "/tmp/megadie-admin-session-desktop-warning.png", fullPage: true });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    assert.equal(state.expiresAt, start + 30 * minute);
    assert.equal(activityCount(), 0);
    await advance(2 * minute);
    await page.waitForURL("**/login");
  });
  await run("typing keeps active work alive beyond the former limit and is throttled", async (t) => {
    const { page, state, advance, activityCount } = await fixture(t);
    await advance(20 * minute);
    const response = page.waitForResponse((r) => r.url().endsWith("/users/session/activity") && r.status() === 200);
    await page.getByPlaceholder(search).pressSequentially("working");
    await response;
    assert.equal(activityCount(), 1);
    assert.equal(state.expiresAt, state.now + 30 * minute);
    await advance(20 * minute);
    const again = page.waitForResponse((r) => r.url().endsWith("/users/session/activity") && r.status() === 200);
    await page.getByPlaceholder(search).press("a");
    await again;
    assert.equal(new URL(page.url()).pathname, "/admin/orders");
    assert.equal(activityCount(), 2);
  });
  await run("Stay signed in preserves unsaved fields and the current page", async (t) => {
    const { page, state, advance } = await fixture(t);
    await page.goto(origin + "/account/profile");
    const firstActivity = page.waitForResponse((r) => r.url().endsWith("/users/session/activity") && r.status() === 200);
    await page.getByRole("button", { name: "Edit Profile", exact: true }).click();
    const name = page.locator("input").nth(1);
    await name.fill("Unsaved owner name");
    await firstActivity;
    await advance(28 * minute + 500);
    const warning = page.getByRole("region", { name: "Admin session warning" });
    await warning.waitFor();
    await warning.getByRole("button", { name: "Stay signed in", exact: true }).click();
    await warning.waitFor({ state: "hidden" });
    assert.equal(await name.inputValue(), "Unsaved owner name");
    assert.equal(new URL(page.url()).pathname, "/account/profile");
    assert.equal(state.expiresAt, state.now + 30 * minute);
  });
  await run("activity cannot extend the eight-hour maximum", async (t) => {
    const { page, state, start, advance } = await fixture(t);
    for (let i = 0; i < 23; i++) {
      await advance(20 * minute);
      const response = page.waitForResponse((r) => r.url().endsWith("/users/session/activity") && r.status() === 200);
      await page.getByPlaceholder(search).press("a");
      await response;
    }
    assert.equal(state.absoluteAt, start + 480 * minute);
    await advance(18 * minute + 100);
    await page.getByText("Your work session is ending soon", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Stay signed in" }).count(), 0);
    await advance(2 * minute);
    await page.waitForURL("**/login");
  });
  await run("failed renewal reports the connection problem without extending the session", async (t) => {
    const { page, state, start, advance } = await fixture(t, { mobile: true });
    await advance(28 * minute + 100);
    state.failActivity = true;
    await page.getByRole("button", { name: "Stay signed in" }).click();
    await page.getByText("Session connection problem", { exact: true }).waitFor();
    assert.equal(state.expiresAt, start + 30 * minute);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: "/tmp/megadie-admin-session-mobile-warning.png", fullPage: true });
    state.failActivity = false;
    await page.getByRole("button", { name: "Stay signed in" }).click();
    await page.getByRole("region", { name: "Admin session warning" }).waitFor({ state: "hidden" });
  });
  await run("sleeping devices recheck server expiry on return", async (t) => {
    const { page, state, start } = await fixture(t);
    state.now = start + 31 * minute;
    await page.clock.setSystemTime(state.now);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForURL("**/login");
  });
  await run("hidden and synthetic activity cannot renew sessions", async (t) => {
    const { page, advance, activityCount } = await fixture(t);
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    });
    await advance(20 * minute);
    await page.keyboard.press("a");
    assert.equal(activityCount(), 0);
  });
  await run("renewal in one tab updates the other tab without making it renew", async (t) => {
    const { page, state, newPage, advance, activityCount } = await fixture(t);
    const other = await newPage();
    await other.getByPlaceholder(search).waitFor();
    await advance(20 * minute);
    const response = page.waitForResponse((r) => r.url().endsWith("/users/session/activity") && r.status() === 200);
    const otherResponse = other.waitForResponse((r) => r.url().endsWith("/users/account/profile") && r.status() === 200);
    await page.getByPlaceholder(search).press("a");
    await response;
    await otherResponse;
    await advance(11 * minute);
    assert.equal(state.signedIn, true);
    assert.equal(new URL(other.url()).pathname, "/admin/orders");
    assert.equal(activityCount(), 1);
    assert.equal(await other.getByRole("region", { name: "Admin session warning" }).count(), 0);
  });
  await run("explicit logout propagates to other tabs", async (t) => {
    const { page, newPage } = await fixture(t);
    const other = await newPage();
    await other.getByPlaceholder(search).waitFor();
    await page.getByRole("button", { name: "Logout", exact: true }).first().click();
    await other.waitForURL("**/login");
  });
  await run("a delayed 401 from an older session cannot sign out a newer login", async (t) => {
    const { page, state, newPage, login } = await fixture(t);
    state.holdUsers = true;
    await page.getByRole("link", { name: "Users", exact: true }).click();
    state.signedIn = false;
    const other = await newPage();
    await login(other);
    await page.getByText(`Session Test Admin ${state.sessionId}`, { exact: true }).first().waitFor();
    assert.ok(state.finishUsers);
    state.finishUsers();
    await page.clock.runFor(100);
    assert.notEqual(new URL(page.url()).pathname, "/login");
    assert.equal(state.signedIn, true);
  });
  await run("a delayed logout response cannot clear a newer login in either tab", async (t) => {
    const { page, state, newPage, login } = await fixture(t);
    state.holdLogout = true;
    await page.getByRole("button", { name: "Logout", exact: true }).first().click();
    state.signedIn = false;
    const other = await newPage();
    await login(other);
    await page.getByText(`Session Test Admin ${state.sessionId}`, { exact: true }).first().waitFor();
    assert.ok(state.finishLogout);
    state.finishLogout();
    await page.clock.runFor(100);
    assert.equal(state.signedIn, true);
    assert.notEqual(new URL(page.url()).pathname, "/login");
    assert.notEqual(new URL(other.url()).pathname, "/login");
  });
  await run("missing admin metadata fails closed and customers keep their original session", async (t) => {
    const broken = await fixture(t, { missingMetadata: true });
    await broken.page.waitForURL("**/login");
    const customer = await fixture(t, { admin: false });
    await customer.advance(60 * minute);
    assert.equal(new URL(customer.page.url()).pathname, "/account/profile");
    assert.equal(await customer.page.getByRole("region", { name: "Admin session warning" }).count(), 0);
    assert.equal(customer.activityCount(), 0);
  });
});
