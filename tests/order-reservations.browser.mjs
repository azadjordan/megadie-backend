// API interception keeps these browser checks away from production/database data.
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const origin = process.env.RESERVATION_TEST_ORIGIN || "http://127.0.0.1:5173";
const orderId = "100000000000000000000001";
const products = ["300000000000000000000001", "300000000000000000000002", "300000000000000000000003"];
const slots = ["400000000000000000000001", "400000000000000000000002", "400000000000000000000003", "400000000000000000000004"];
const skus = ["RIB-GRO-WHITE-029", "RIB-GRO-CREAM-815", "RIB-SAT-BLUE-040"];
const sessionAbsoluteExpiresAt = Date.now() + 28800000;
const sessionMetadata = () => ({ sessionId: "fixture-admin-session", sessionAbsoluteExpiresAt, sessionExpiresAt: Date.now() + 1800000, sessionServerTime: Date.now() });
const profile = { _id: "200000000000000000000001", name: "Admin", email: "admin@test.invalid", isAdmin: true, approvalStatus: "Approved" };

test("Reserve all items browser flow", { timeout: 120000 }, async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  async function fixture(t, { width = 1536, status = "Shipping", mode = "blocked", duplicate = false } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 1100 } });
    t.after(() => context.close());
    const state = { mode, requests: [], unexpected: [], errors: [], bulkCalls: 0,
      order: { _id: orderId, orderNumber: "ORD-261110-ABC123", status, createdAt: "2026-11-10T10:00:00Z", user: { _id: "client", name: "Ahmed Trading" }, invoice: null, quote: null,
        orderItems: products.map((product, index) => ({ product, sku: skus[index], productName: ["White grosgrain ribbon", "Cream grosgrain ribbon", "Blue satin ribbon"][index], qty: [12, 8, 4][index], unitPrice: 10 })), totalPrice: 240, allocationStatus: "PartiallyAllocated" },
      allocations: [{ _id: "500000000000000000000001", product: { _id: products[0] }, slot: { _id: slots[0], label: "A2-AE1" }, qty: 4, status: "Reserved" }],
    };
    if (duplicate) {
      state.order.orderItems[0].qty = 5;
      state.order.orderItems.push({ ...state.order.orderItems[0], qty: 7 });
    }
    const slotRow = (product, slot, label, qty) => ({ _id: `${product}-${slot}`, product, slot: { _id: slot, label, store: "AE1" }, qty, availableQty: qty, reservedQty: 0 });
    const stock = (product) => product === products[0] ? [slotRow(product, slots[0], "A2-AE1", 4), slotRow(product, slots[1], "A10-AE1", 8)]
      : product === products[1] ? [slotRow(product, slots[2], "E7-AE1", state.mode === "blocked" ? 5 : 8)]
      : state.mode === "blocked" ? [] : [slotRow(product, slots[3], "B4-AE1", 4)];
    function complete() {
      state.allocations = [state.allocations[0], ...products.map((product, index) => ({ _id: `60000000000000000000000${index + 1}`, product: { _id: product }, slot: { _id: slots[index + 1], label: ["A10-AE1", "E7-AE1", "B4-AE1"][index] }, qty: [8, 8, 4][index], status: "Reserved" }))];
      state.order.allocationStatus = "Allocated";
    }
    await context.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (!url.pathname.startsWith("/api/")) return url.origin === origin ? route.continue() : route.abort();
      const path = url.pathname.slice(4), method = request.method();
      const headers = { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,DELETE,OPTIONS" };
      const reply = (body, status = 200) => route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify(body) });
      if (method === "OPTIONS") return route.fulfill({ status: 204, headers });
      state.requests.push({ path, method });
      if (path === "/users/account/profile") return reply({ data: { ...profile, ...sessionMetadata() } });
      if (path === "/users/session/activity") return reply({ data: sessionMetadata() });
      if (path === "/site-settings/maintenance-notice") return reply({ data: { enabled: false } });
      if (path === `/orders/${orderId}` && method === "GET") return reply({ data: state.order });
      if (path === `/orders/${orderId}/allocations` && method === "GET") return state.failReads ? reply({ message: "Could not refresh reservations" }, 500) : reply({ data: state.allocations });
      if (path.startsWith("/slot-items/by-product/")) return reply({ data: stock(path.split("/").at(-1)) });
      if (path === `/orders/${orderId}/allocations/reserve-all` && method === "POST") {
        state.bulkCalls++;
        if (state.deferBulk) await new Promise((resolve) => { state.finishBulk = resolve; });
        if (state.mode === "blocked") return reply({ code: "RESERVATION_BLOCKED", noNewReservations: true, message: "No new reservations made.", issues: [
          { productId: products[1], sku: skus[1], orderedQty: 8, reservedQty: 0, neededQty: 8, availableQty: 5, shortageQty: 3, message: "Insufficient available stock." },
          { productId: products[2], sku: skus[2], orderedQty: 4, reservedQty: 0, neededQty: 4, availableQty: 0, shortageQty: 4, message: "No stock slots found. Check the stock location and slot assignment." },
        ] }, 409);
        complete();
        if (state.mode === "lost") return route.abort("failed");
        if (state.mode === "refresh-fails") state.failReads = true;
        return reply({ data: { itemCount: 3, addedQty: 20 } });
      }
      if (path === `/orders/${orderId}/allocations` && method === "POST") {
        if (state.deferManual) await new Promise((resolve) => { state.finishManual = resolve; });
        const body = request.postDataJSON();
        const existing = state.allocations.find((row) => row.product._id === body.productId && row.slot._id === body.slotId);
        if (existing) existing.qty = body.qty;
        else state.allocations.push({ _id: "700000000000000000000001", product: { _id: body.productId }, slot: { _id: body.slotId, label: "A10-AE1" }, qty: body.qty, status: "Reserved" });
        return reply({ data: existing || state.allocations.at(-1) });
      }
      state.unexpected.push(`${method} ${path}`);
      return reply({ message: "Unexpected request" }, 500);
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => state.errors.push(error.message));
    t.after(() => { assert.deepEqual(state.errors, []); assert.deepEqual(state.unexpected, []); });
    await page.goto(`${origin}/admin/orders/${orderId}?tab=stock`);
    const bulk = page.getByRole("button", { name: "Reserve all items", exact: true });
    await bulk.waitFor();
    if (status === "Shipping") await bulk.waitFor({ state: "visible" });
    return { page, state, bulk };
  }

  await t.test("blocked report persists and reviews each item on desktop and mobile", async (t) => {
    for (const width of [1536, 390]) {
      const { page, state, bulk } = await fixture(t, { width });
      await bulk.click();
      // The report is an alert; locate by its accessible label for both outcomes.
      const panel = page.locator('[aria-label="Order reservation result"]');
      await panel.getByRole("heading", { name: "Reservation blocked · 2 items need attention" }).waitFor();
      assert.match(await panel.textContent(), /No new reservations made/);
      assert.match(await panel.textContent(), /Existing reservations remain unchanged/);
      assert.match(await panel.getByRole("article", { name: skus[1] }).textContent(), /Insufficient available stock/);
      await panel.getByRole("article", { name: skus[1] }).getByRole("button", { name: "Review item" }).click();
      const selected = page.getByRole("region", { name: `Stock slots for ${skus[1]}` });
      await selected.waitFor();
      assert.equal(await selected.evaluate((node) => node === document.activeElement), true);
      assert.equal(await panel.isVisible(), true);
      assert.equal(state.requests.filter((r) => r.method === "POST" && r.path !== "/users/session/activity").length, 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: `/tmp/megadie-reserve-all-${width}.png`, fullPage: true });
    }
  });
  await t.test("successful retry refreshes every item and prevents another bulk request", async (t) => {
    const { page, state, bulk } = await fixture(t);
    await bulk.click();
    await page.getByText("Reservation blocked · 2 items need attention").waitFor();
    state.mode = "success";
    await page.getByRole("button", { name: "Check again & reserve all" }).click();
    await page.getByRole("heading", { name: "All items fully reserved", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "All items reserved", exact: true }).isDisabled(), true);
    assert.match(await page.locator('[aria-label="Order reservation result"]').textContent(), /Added 20 units/);
    assert.equal(state.bulkCalls, 2);
    assert.equal(state.allocations.reduce((sum, row) => sum + row.qty, 0), 24);
    assert.equal(await page.getByText("Reservation blocked · 2 items need attention").count(), 0);
    await page.screenshot({ path: "/tmp/megadie-reserve-all-success.png", fullPage: true });
  });
  await t.test("double click submits once and disables competing manual edits", async (t) => {
    const { page, state, bulk } = await fixture(t, { mode: "success" });
    state.deferBulk = true;
    await bulk.evaluate((node) => { node.click(); node.click(); });
    await page.getByRole("button", { name: "Checking & reserving…" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Checking & reserving…" }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Reserve", exact: true }).filter({ visible: true }).first().isDisabled(), true);
    while (!state.finishBulk) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(state.bulkCalls, 1);
    state.finishBulk();
    await page.getByRole("heading", { name: "All items fully reserved" }).waitFor();
  });
  await t.test("a lost response requires a read before any more reservations", async (t) => {
    const { page, state, bulk } = await fixture(t, { mode: "lost", width: 390 });
    await bulk.click();
    await page.getByRole("heading", { name: "Reservation result could not be confirmed" }).waitFor();
    const panel = page.locator('[aria-label="Order reservation result"]');
    assert.doesNotMatch(await panel.textContent(), /No new reservations made/);
    const refresh = page.getByRole("button", { name: "Refresh reservations", exact: true });
    await refresh.click();
    await page.getByRole("heading", { name: "Reservations refreshed" }).waitFor();
    assert.equal(state.bulkCalls, 1);
    assert.equal(await page.getByRole("button", { name: "All items reserved", exact: true }).isDisabled(), true);
  });
  await t.test("a confirmed save with failed refresh can refresh without reserving twice", async (t) => {
    const { page, state, bulk } = await fixture(t, { mode: "refresh-fails" });
    await bulk.click();
    await page.getByRole("button", { name: "Refresh reservations", exact: true }).waitFor();
    assert.match(await page.locator('[aria-label="Order reservation result"]').textContent(), /All items fully reserved/);
    state.failReads = false;
    await page.getByRole("button", { name: "Refresh reservations", exact: true }).click();
    await page.getByRole("heading", { name: "Reservations refreshed" }).waitFor();
    assert.equal(state.bulkCalls, 1);
  });
  await t.test("manual changes disable the bulk button and make older issue reports stale", async (t) => {
    const { page, state, bulk } = await fixture(t);
    await bulk.click();
    await page.getByText("Reservation blocked · 2 items need attention").waitFor();
    state.deferManual = true;
    const detail = page.getByRole("region", { name: `Stock slots for ${skus[0]}` });
    const reserve = detail.getByRole("button", { name: "Reserve", exact: true }).filter({ visible: true }).last();
    await reserve.click();
    while (!state.finishManual) await new Promise((resolve) => setTimeout(resolve, 10));
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some((node) => node.textContent === "Check again & reserve all" && node.disabled));
    assert.equal(await page.getByRole("button", { name: "Check again & reserve all" }).isDisabled(), true);
    state.finishManual();
    await page.getByText("Reservations changed since this report. Check again for current availability.").waitFor();
  });
  await t.test("Shipping restrictions are visible and duplicate products share one reservation total", async (t) => {
    for (const status of ["Processing", "Delivered", "Cancelled"]) {
      const { bulk, state } = await fixture(t, { status });
      assert.equal(await bulk.isDisabled(), true);
      assert.equal(state.bulkCalls, 0);
    }
    const { page, bulk } = await fixture(t, { duplicate: true, mode: "success" });
    await bulk.click();
    await page.getByRole("heading", { name: "All items fully reserved" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "All items reserved", exact: true }).isDisabled(), true);
  });
});
