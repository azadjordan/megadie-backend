// All API traffic is intercepted. Clock changes simulate expiry without waiting.
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const origin = process.env.AUTH_TEST_ORIGIN || "http://localhost:5173";
const minute = 60000;
const warning = "Your admin session expires soon. Save your work before signing in again.";

test("admin absolute-session browser flow", { timeout: 120000 }, async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const run = (name, fn) => t.test(name, { skip: process.env.AUTH_TEST_CASE && !name.includes(process.env.AUTH_TEST_CASE) }, fn);
  async function fixture(t, { admin = true, signedIn = true, missingMetadata = false, mobile = false } = {}) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1400, height: 1000 } });
    t.after(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const start = Date.now();
    await page.clock.install({ time: new Date(start) });
    const state = { now: start, expiresAt: start + (admin ? 20 * minute : 30 * 24 * 60 * minute), signedIn, requests: [], errors: [], rejectProtected: false };
    const profile = () => ({ _id: "fixture-user", name: admin ? "Session Test Admin" : "Session Test Client", email: "session@test.invalid", phoneNumber: "TEST-PHONE", isAdmin: admin, approvalStatus: "Approved",
      ...(missingMetadata ? {} : { sessionExpiresAt: state.expiresAt, sessionServerTime: state.now }) });
    page.on("pageerror", (error) => state.errors.push(error.message));
    t.after(() => assert.deepEqual(state.errors, []));
    await context.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (!url.pathname.startsWith("/api/")) return url.origin === origin ? route.continue() : route.abort();
      const path = url.pathname.slice(4), method = request.method();
      state.requests.push({ path, method });
      const headers = { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,PUT,OPTIONS" };
      const reply = (body, status = 200) => route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify(body) });
      if (method === "OPTIONS") return route.fulfill({ status: 204, headers });
      if (path === "/site-settings/maintenance-notice") return reply({ data: { enabled: false } });
      if (path === "/users/auth" && method === "POST") {
        state.signedIn = true;
        state.expiresAt = state.now + (admin ? 20 * minute : 30 * 24 * 60 * minute);
        return reply({ data: profile() });
      }
      if (path === "/users/logout" && method === "POST") { state.signedIn = false; return reply({ success: true }); }
      if (!state.signedIn || state.now >= state.expiresAt || state.rejectProtected) return reply({ message: "Session expired or invalid. Please sign in again." }, 401);
      if (path === "/users/account/profile") return reply({ data: profile() });
      if (path === "/orders/work-summary") return reply({ data: {} });
      if (path === "/orders") return reply({ data: [], pagination: { page: 1, total: 0, totalPages: 1, limit: 20 } });
      return reply({ data: [] });
    });
    const advance = async (ms) => { state.now += ms; await page.clock.fastForward(ms); };
    const login = async () => {
      await page.locator('input[type="email"]').fill("session@test.invalid");
      await page.locator('input[type="password"]').fill("test-password");
      const ordersLoaded = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/orders" && response.status() === 200);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await ordersLoaded;
      await page.waitForURL("**/admin/orders");
      await page.getByText("Track orders created from quotes and manage fulfillment.", { exact: true }).waitFor();
    };
    await page.goto(origin + (admin ? "/admin/orders" : "/account/profile"));
    if (signedIn && !missingMetadata) await page.getByText(admin ? "Track orders created from quotes and manage fulfillment." : "Keep your contact details up to date.", { exact: true }).waitFor();
    return { page, state, start, advance, login };
  }

  await run("warns at 18 minutes and expires at 20 despite activity; re-login fetches fresh admin data", async (t) => {
    const { page, state, advance, login } = await fixture(t);
    const reads = () => state.requests.filter((r) => r.path === "/orders" && r.method === "GET").length;
    assert.equal(reads(), 1);
    await advance(17 * minute);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    assert.equal(await page.getByText(warning, { exact: true }).count(), 0);
    await advance(minute + 1500);
    await page.getByText(warning, { exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/admin/orders");
    assert.equal(state.requests.filter((r) => r.path === "/users/account/profile").length, 1, "No session polling");
    await advance(2 * minute);
    await page.waitForURL("**/login");
    await page.getByText(warning, { exact: true }).waitFor({ state: "hidden" });
    assert.equal(await page.getByText("Track orders created from quotes and manage fulfillment.", { exact: true }).count(), 0);
    await page.getByText("Your admin session expired. Please sign in again.", { exact: true }).waitFor();
    assert.equal(state.requests.filter((r) => r.path === "/users/logout").length, 0, "Expiry does not send a delayed logout that could clear a newer tab's login");
    await login();
    assert.equal(reads(), 2, "Old RTK admin data was cleared");
    await advance(17 * minute);
    assert.equal(new URL(page.url()).pathname, "/admin/orders");
    assert.equal(await page.getByText(warning, { exact: true }).count(), 0);
  });
  await run("a fresh login starts its timer from the server-issued deadline", async (t) => {
    const { page, advance, login } = await fixture(t, { signedIn: false });
    await page.waitForURL("**/login");
    await login();
    await advance(18 * minute + 1500);
    await page.getByText(warning, { exact: true }).waitFor();
    await advance(2 * minute);
    await page.waitForURL("**/login");
  });
  await run("refreshing at 15 minutes keeps only the remaining five minutes", async (t) => {
    const { page, state, advance } = await fixture(t);
    const expiresAt = state.expiresAt;
    await advance(15 * minute);
    await page.reload();
    await page.getByText("Track orders created from quotes and manage fulfillment.", { exact: true }).waitFor();
    assert.equal(state.expiresAt, expiresAt);
    await advance(3 * minute + 1500);
    await page.getByText(warning, { exact: true }).waitFor();
    await advance(2 * minute);
    await page.waitForURL("**/login");
  });
  await run("returning focus after sleep checks expiry without needing a timer or API request", async (t) => {
    const { page, state, start } = await fixture(t);
    state.now = start + 21 * minute;
    await page.clock.setSystemTime(state.now);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForURL("**/login");
  });
  await run("visibility changes also enforce expiry on mobile", async (t) => {
    const { page, state, start } = await fixture(t, { mobile: true });
    state.now = start + 19 * minute;
    await page.clock.setSystemTime(state.now);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.getByText(warning, { exact: true }).waitFor();
    await page.screenshot({ path: "/tmp/megadie-admin-session-mobile-warning.png", fullPage: true, animations: "disabled" });
    state.now = start + 21 * minute;
    await page.clock.setSystemTime(state.now);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForURL("**/login");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  });
  await run("server rejection signs out before the local deadline", async (t) => {
    const { page, state } = await fixture(t);
    state.rejectProtected = true;
    await page.getByRole("link", { name: "Users", exact: true }).click();
    await page.waitForURL("**/login");
  });
  await run("an admin response without expiry metadata cannot create an unlimited UI session", async (t) => {
    const { page } = await fixture(t, { missingMetadata: true });
    await page.waitForURL("**/login");
  });
  await run("customers remain signed in without an admin warning after 21 minutes", async (t) => {
    const { page, advance } = await fixture(t, { admin: false });
    await advance(21 * minute);
    assert.equal(new URL(page.url()).pathname, "/account/profile");
    assert.equal(await page.getByText(warning, { exact: true }).count(), 0);
    assert.equal(await page.getByText("Your admin session expired. Please sign in again.", { exact: true }).count(), 0);
  });
});
