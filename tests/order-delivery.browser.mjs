// Browser API interception prevents any production/database access or OS clipboard writes.
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const origin = process.env.DELIVERY_TEST_ORIGIN || "http://localhost:5173";
const details = { contactName: "Order Recipient", phoneNumber: "+123456", secondaryPhoneNumber: "", address: "Order-only address", googleMapsUrl: "https://maps.app.goo.gl/client", notes: "Receiving hours" };
const id = "100000000000000000000001";
const profile = { _id: "200000000000000000000001", name: "Admin", email: "admin@test.invalid", isAdmin: true, approvalStatus: "Approved" };

test("order delivery browser flow", { timeout: 120000 }, async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  async function fixture(t, { legacy = false, mobile = false, status = "Shipping", locationOnly = false } = {}) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1400, height: 1000 } });
    t.after(() => context.close());
    await context.addInitScript(() => {
      window.__copies = [];
      window.__copyFailure = false;
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => {
        if (window.__copyFailure) throw new Error("Clipboard denied");
        window.__copies.push(text);
      } } });
      document.execCommand = () => false;
    });
    const state = { requests: [], unexpected: [], errors: [], conflict: false,
      order: { _id: id, orderNumber: "ORD-261102-023AD", status, createdAt: "2026-11-02T10:00:00Z", user: { _id: "client", name: "Alpha Beta Company", phoneNumber: "ACCOUNT-PHONE", address: "LIVE-PROFILE-ADDRESS" },
        orderItems: [{ product: "p1", sku: "SKU1", productName: "Grosgrain ribbon", qty: 4, unitPrice: 10 }], totalPrice: 40, allocationStatus: "Allocated", invoice: null,
        resolvedDelivery: { details: locationOnly ? { address: details.address, googleMapsUrl: details.googleMapsUrl } : { ...details }, savedToOrder: !legacy, revision: legacy ? 0 : 1, missingFields: locationOnly ? ["contactName", "phoneNumber"] : [] } },
    };
    state.customer = { ...state.order.user, email: "client@test.invalid", deliveryContactName: "", deliveryPhoneNumber: "" };
    const sheet = () => ({ orderId: id, orderNumber: state.order.orderNumber, status: state.order.status,
      generatedAt: "2026-11-02T10:00:00Z", label: "ABC-023AD", delivery: { ...state.order.resolvedDelivery, missingFields: state.order.resolvedDelivery.missingFields.filter((key) => key === "addressOrLocation") },
      problems: state.order.resolvedDelivery.savedToOrder ? [] : ["Review and save the delivery details for this order."], notices: [],
      picks: [{ slot: "A10-AE1", sku: "SKU1", name: "Grosgrain ribbon", qty: 1 }, { slot: "A2-AE1", sku: "SKU1", name: "Grosgrain ribbon", qty: 3 }],
      items: [{ productId: "p1", sku: "SKU1", name: "Grosgrain ribbon", orderedQty: 4, allocatedQty: 4 }],
    });
    await context.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (!url.pathname.startsWith("/api/")) return url.origin === origin ? route.continue() : route.abort();
      const path = url.pathname.slice(4), method = request.method();
      const headers = { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,PUT,POST,OPTIONS" };
      const reply = (body, status = 200) => route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify(body) });
      if (method === "OPTIONS") return route.fulfill({ status: 204, headers });
      state.requests.push({ path, method, body: method === "PUT" ? request.postDataJSON() : undefined });
      if (path === "/users/account/profile" && method === "GET") return reply({ data: profile });
      if (path === "/site-settings/maintenance-notice") return reply({ data: { enabled: false } });
      if (path === "/users/client" && method === "GET") return reply({ data: state.customer });
      if (path === "/users/client" && method === "PUT") { state.customer = { ...state.customer, ...request.postDataJSON() }; return reply({ data: state.customer }); }
      if (path === "/user-prices/client" || path === "/price-rules") return reply({ data: [] });
      if (path === "/orders/work-summary") return reply({ data: {} });
      if (path === "/orders" && method === "GET") return reply({ data: [state.order], pagination: { page: 1, totalPages: 1, total: 1, limit: 20 } });
      if (path === `/orders/${id}` && method === "GET") return reply({ data: state.order });
      if (path === `/orders/${id}/fulfillment-sheet` && method === "GET") return reply({ data: sheet() });
      if (path === `/orders/${id}/delivery-details` && method === "PUT") {
        if (state.conflict) {
          state.conflict = false;
          state.order.resolvedDelivery = { ...state.order.resolvedDelivery, revision: 2, details: { ...details, contactName: "Other admin" } };
          return reply({ message: "Order changed. Reload and review before saving." }, 409);
        }
        const body = request.postDataJSON();
        assert.equal(body.expectedRevision, state.order.resolvedDelivery.revision);
        state.order.resolvedDelivery = { details: body.deliveryDetails, savedToOrder: true, revision: body.expectedRevision + 1, missingFields: [] };
        return reply({ data: { _id: id, resolvedDelivery: state.order.resolvedDelivery } });
      }
      state.unexpected.push(`${method} ${path}`);
      return reply({ message: "Unexpected test request" }, 500);
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => state.errors.push(error.message));
    t.after(() => { assert.deepEqual(state.errors, []); assert.deepEqual(state.unexpected, []); });
    await page.goto(origin + "/admin/orders");
    await page.getByRole("button", { name: "Copy prepare and deliver sheet" }).waitFor();
    return { page, state };
  }

  await t.test("complete order copies once with compact label first, and each later click reads fresh", async (t) => {
    const { page, state } = await fixture(t);
    assert.equal(state.requests.filter((r) => r.path.endsWith("fulfillment-sheet")).length, 0);
    await page.getByRole("button", { name: "Copy prepare and deliver sheet" }).click();
    await page.waitForFunction(() => window.__copies.length === 1);
    let text = await page.evaluate(() => window.__copies[0]);
    assert.equal(text.split("\n")[0], "*Carton Tag: ABC-023AD*");
    assert.match(text, /Order-only address/);
    assert.doesNotMatch(text, /LIVE-PROFILE|ACCOUNT-PHONE|PICKUP|Order total|Grosgrain ribbon|Order Recipient|Contact:|Phone:|Notes:|Receiving hours/);
    assert.match(text, /1 item — 4 units/);
    assert.match(text, /• \*SKU1\*\n\n- A2-AE1: 3 units\n- A10-AE1: 1 unit\n- Total: 4 units/);
    assert.equal(await page.getByRole("dialog").count(), 0);
    state.order.resolvedDelivery.details.address = "NEW-ADDRESS";
    await page.getByRole("button", { name: "Copy prepare and deliver sheet" }).click();
    await page.waitForFunction(() => window.__copies.length === 2);
    text = await page.evaluate(() => window.__copies[1]);
    assert.match(text, /NEW-ADDRESS/);
    assert.equal(state.requests.filter((r) => r.path.endsWith("fulfillment-sheet")).length, 2);
    assert.equal(state.requests.filter((r) => r.method !== "GET").length, 0);
  });
  await t.test("legacy destination is reviewed and saved to the order, then the updated sheet copies", async (t) => {
    const { page, state } = await fixture(t, { legacy: true });
    await page.getByRole("button", { name: "Copy prepare and deliver sheet" }).click();
    await page.getByRole("dialog").waitFor();
    assert.equal(await page.evaluate(() => window.__copies.length), 0);
    const close = page.getByRole("button", { name: "Close prepare and deliver" });
    await close.focus();
    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Save & Copy");
    await page.keyboard.press("Tab");
    assert.equal(await close.evaluate((node) => node === document.activeElement), true);
    await page.getByLabel("Address", { exact: true }).fill("New order destination");
    await page.getByRole("button", { name: "Save & Copy", exact: true }).click();
    await page.waitForFunction(() => window.__copies.length === 1);
    assert.match(await page.evaluate(() => window.__copies[0]), /New order destination/);
    const writes = state.requests.filter((r) => r.method !== "GET");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, `/orders/${id}/delivery-details`);
    assert.equal(writes[0].body.expectedRevision, 0);
    assert.equal(state.order.user.address, "LIVE-PROFILE-ADDRESS");
  });
  await t.test("staff copying accepts location-only details for current and legacy orders", async (t) => {
    for (const legacy of [false, true]) {
      const { page, state } = await fixture(t, { locationOnly: true, legacy });
      await page.getByRole("button", { name: "Copy prepare and deliver sheet" }).click();
      if (legacy) {
        await page.getByRole("dialog").waitFor();
        const save = page.getByRole("button", { name: "Save & Copy", exact: true });
        assert.equal(await save.isEnabled(), true);
        await save.click();
      }
      await page.waitForFunction(() => window.__copies.length === 1);
      const text = await page.evaluate(() => window.__copies[0]);
      assert.match(text, /Address: Order-only address/);
      assert.doesNotMatch(text, /Contact:|Phone:|Notes:|Grosgrain ribbon|Order Recipient/);
      assert.equal(state.requests.filter((r) => r.method === "PUT").length, legacy ? 1 : 0);
    }
  });
  await t.test("Courier edits are order-only and conflicting saves keep entered text", async (t) => {
    const { page, state } = await fixture(t);
    await page.getByRole("button", { name: /Courier/ }).first().click();
    await page.getByRole("dialog").waitFor();
    await page.getByLabel("Recipient name").fill("My unsaved contact");
    state.conflict = true;
    await page.getByRole("button", { name: "Save & Copy", exact: true }).click();
    await page.getByText("Order changed. Reload and review before saving.").first().waitFor();
    assert.equal(await page.getByLabel("Recipient name").inputValue(), "My unsaved contact");
    assert.equal(await page.evaluate(() => window.__copies.length), 0);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Reload details" }).click();
    await page.waitForFunction(() => document.querySelector("#courier-contact-name")?.value === "Other admin");
    await page.getByRole("dialog").getByRole("button", { name: "Copy", exact: true }).click();
    await page.waitForFunction(() => window.__copies.length === 1);
    const text = await page.evaluate(() => window.__copies[0]);
    assert.match(text, /Other admin/);
    assert.match(text, /_PICKUP_/);
    assert.equal(state.requests.filter((r) => r.path.startsWith("/users/") && r.method === "PUT").length, 0);
  });
  await t.test("incomplete order destination can be saved without filling blanks from the profile", async (t) => {
    const { page, state } = await fixture(t);
    await page.getByRole("button", { name: /Courier/ }).first().click();
    await page.getByRole("dialog").waitFor();
    await page.getByLabel("Google Maps location").fill("");
    await page.getByLabel("Address", { exact: true }).fill("");
    await page.getByRole("button", { name: "Save for this order", exact: true }).click();
    await page.getByText("Delivery details saved for this order.").first().waitFor();
    assert.equal(state.order.resolvedDelivery.details.address, "");
    assert.equal(state.order.user.address, "LIVE-PROFILE-ADDRESS");
    assert.equal(await page.getByRole("dialog").getByRole("button", { name: "Copy", exact: true }).isDisabled(), true);
    assert.equal(await page.evaluate(() => window.__copies.length), 0);
  });
  await t.test("existing customer editor saves optional contact defaults separately from account identity", async (t) => {
    const { page, state } = await fixture(t);
    await page.goto(origin + "/admin/users/client/edit");
    await page.getByLabel("Delivery contact name (optional)", { exact: true }).fill("Default reception");
    await page.getByLabel("Delivery phone (optional)", { exact: true }).fill("DEFAULT-RECIPIENT-PHONE");
    await page.getByRole("button", { name: /Save.*info|Update.*info|Save changes/i }).first().click();
    await page.waitForFunction(() => document.body.textContent.includes("User info updated."));
    assert.equal(state.customer.deliveryContactName, "Default reception");
    assert.equal(state.customer.deliveryPhoneNumber, "DEFAULT-RECIPIENT-PHONE");
    assert.equal(state.customer.phoneNumber, "ACCOUNT-PHONE");
  });
  await t.test("clipboard retry uses the prepared preview without another request", async (t) => {
    const { page, state } = await fixture(t, { mobile: true });
    await page.evaluate(() => { window.__copyFailure = true; });
    await page.getByRole("button", { name: "Copy prepare and deliver sheet" }).click();
    await page.getByRole("dialog").waitFor();
    assert.match(await page.getByLabel("Message preview").inputValue(), /^\*Carton Tag: ABC-023AD\*\n/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    // Dismiss the temporary clipboard-error toast before checking modal/navigation stacking.
    await page.locator(".Toastify__close-button").first().click();
    await page.locator(".Toastify__toast").waitFor({ state: "detached" });
    const close = page.getByRole("button", { name: "Close prepare and deliver" });
    await page.screenshot({ path: "/tmp/megadie-delivery-mobile.png", fullPage: true });
    const hit = await close.evaluate((node) => { const r = node.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); const overlay = node.closest("[role=dialog]").parentElement; return { topmost: node.contains(hit), rect: r.toJSON(), hit: hit?.outerHTML.slice(0, 220), overlayZ: getComputedStyle(overlay).zIndex, parent: overlay.parentElement.tagName }; });
    assert.equal(hit.topmost, true, JSON.stringify(hit));
    await page.evaluate(() => { window.__copyFailure = false; });
    await page.getByRole("dialog").getByRole("button", { name: "Copy", exact: true }).click();
    await page.waitForFunction(() => window.__copies.length === 1);
    assert.equal(state.requests.filter((r) => r.path.endsWith("fulfillment-sheet")).length, 1);
  });
  await t.test("closed orders cannot initiate staff copying", async (t) => {
    for (const status of ["Delivered", "Cancelled"]) {
      const { page, state } = await fixture(t, { status });
      assert.equal(await page.getByRole("button", { name: "Copy prepare and deliver sheet" }).isDisabled(), true);
      assert.equal(state.requests.filter((r) => r.path.endsWith("fulfillment-sheet")).length, 0);
    }
  });
});
