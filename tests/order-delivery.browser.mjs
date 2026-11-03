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
  async function fixture(t, { legacy = false, mobile = false, status = "Shipping", locationOnly = false, assignedTo = "Ahmed", preparationMode = "prepare_deliver" } = {}) {
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
      order: { _id: id, orderNumber: "ORD-261102-023AD", status, assignedTo, preparationMode, createdAt: "2026-11-02T10:00:00Z", user: { _id: "client", name: "Alpha Beta Company", phoneNumber: "ACCOUNT-PHONE", address: "LIVE-PROFILE-ADDRESS" },
        orderItems: [{ product: "p1", sku: "SKU1", productName: "Grosgrain ribbon", qty: 4, unitPrice: 10 }], totalPrice: 40, allocationStatus: "Allocated", invoice: null,
        resolvedDelivery: { details: locationOnly ? { address: details.address, googleMapsUrl: details.googleMapsUrl } : { ...details }, savedToOrder: !legacy, revision: legacy ? 0 : 1, missingFields: locationOnly ? ["contactName", "phoneNumber"] : [] } },
    };
    state.customer = { ...state.order.user, email: "client@test.invalid", deliveryContactName: "", deliveryPhoneNumber: "" };
    const sheet = () => ({ orderId: id, orderNumber: state.order.orderNumber, status: state.order.status,
      preparationMode: state.order.preparationMode,
      customerLocation: { address: state.customer.address || "", googleMapsUrl: state.customer.deliveryGoogleMapsUrl || "" },
      preparationProblems: state.preparationProblems || [],
      generatedAt: "2026-11-02T10:00:00Z", label: "ABC-023AD", assignedTo: state.order.assignedTo, delivery: { ...state.order.resolvedDelivery, missingFields: state.order.resolvedDelivery.missingFields.filter((key) => key === "addressOrLocation") },
      problems: [...(state.preparationProblems || [])], notices: [],
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
      if (path === "/users/account/profile" && method === "GET") return reply({ data: { ...profile, sessionExpiresAt: Date.now() + 1200000, sessionServerTime: Date.now() } });
      if (path === "/site-settings/maintenance-notice") return reply({ data: { enabled: false } });
      if (path === "/users/client" && method === "GET") return reply({ data: state.customer });
      if (path === "/users/client" && method === "PUT") { state.customer = { ...state.customer, ...request.postDataJSON() }; return reply({ data: state.customer }); }
      if (path === "/user-prices/client" || path === "/price-rules") return reply({ data: [] });
      if (path === "/orders/work-summary") return reply({ data: {} });
      if (path === "/orders" && method === "GET") return reply({ data: [state.order], pagination: { page: 1, totalPages: 1, total: 1, limit: 20 } });
      if (path === `/orders/${id}` && method === "GET") return reply({ data: state.order });
      if (path === `/orders/${id}/fulfillment-sheet` && method === "GET") {
        if (state.failNextSheet) { state.failNextSheet = false; return reply({ message: "Could not refresh preparation details." }, 500); }
        return reply({ data: sheet() });
      }
      if (path === `/orders/${id}/delivery-details` && method === "PUT") {
        if (state.conflict) {
          state.conflict = false;
          if (state.conflictAssignedTo !== undefined) state.order.assignedTo = state.conflictAssignedTo;
          state.order.resolvedDelivery = { ...state.order.resolvedDelivery, revision: 2, details: { ...details, contactName: "Other admin" } };
          return reply({ message: "Order changed. Reload and review before saving." }, 409);
        }
        const body = request.postDataJSON();
        if (body.saveCustomerLocation) {
          const current = { address: state.customer.address || "", googleMapsUrl: state.customer.deliveryGoogleMapsUrl || "" };
          if (JSON.stringify(current) !== JSON.stringify(body.expectedCustomerLocation)) return reply({ message: "Customer default location changed. Reload details and review before saving." }, 409);
          state.customer.address = body.deliveryDetails.address;
          state.customer.deliveryGoogleMapsUrl = body.deliveryDetails.googleMapsUrl;
        }
        if (Object.hasOwn(body, "preparationMode")) state.order.preparationMode = body.preparationMode;
        if (Object.hasOwn(body, "assignedTo")) {
          if (!body.assignedTo.trim()) return reply({ message: "Assigned To is required." }, 400);
          state.order.assignedTo = body.assignedTo.trim();
        }
        assert.equal(body.expectedRevision, state.order.resolvedDelivery.revision);
        state.order.resolvedDelivery = { details: body.deliveryDetails, savedToOrder: true, revision: body.expectedRevision + 1, missingFields: [] };
        if (state.failSheetAfterSave) { state.failSheetAfterSave = false; state.failNextSheet = true; }
        return reply({ data: { _id: id, customerId: "client", preparationMode: state.order.preparationMode, assignedTo: state.order.assignedTo, resolvedDelivery: state.order.resolvedDelivery } });
      }
      state.unexpected.push(`${method} ${path}`);
      return reply({ message: "Unexpected test request" }, 500);
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => state.errors.push(error.message));
    t.after(() => { assert.deepEqual(state.errors, []); assert.deepEqual(state.unexpected, []); });
    await page.goto(origin + "/admin/orders");
    await page.getByRole("button", { name: "Prepare order" }).waitFor();
    return { page, state };
  }

  await t.test("every opening reviews fresh details with one fetch and no automatic copying", async (t) => {
    const { page, state } = await fixture(t);
    assert.equal(state.requests.filter((r) => r.path.endsWith("fulfillment-sheet")).length, 0);
    await page.getByRole("button", { name: "Prepare order" }).click();
    await page.getByRole("dialog").waitFor();
    assert.equal(await page.evaluate(() => window.__copies.length), 0);
    const preview = await page.getByLabel("Message preview").inputValue();
    assert.ok(preview.startsWith("*PREPARE & DELIVER*\n_Order:_ ORD-261102-023AD\n_Carton Tag:_ *ABC-023AD*\n_Assigned To:_ *Ahmed*\n*1 item — 4 units*"));
    assert.match(preview, /\*01\)\* SKU1\n   ↳ A2-AE1: \*3 units\*\n   ↳ A10-AE1: \*1 unit\*/);
    assert.ok(preview.includes("☐ *01)* SKU1 — *4*\n*Total: 1 item — 4 units*"));
    assert.doesNotMatch(preview, /LIVE-PROFILE|ACCOUNT-PHONE|PICKUP|Order total|Grosgrain ribbon|Order Recipient|Contact:|Phone:|Notes:|Receiving hours/);
    assert.equal(await page.getByLabel("Message preview").getAttribute("readonly"), "");
    assert.equal(await page.getByLabel("Recipient name", { exact: true }).count(), 0);
    assert.equal(await page.getByLabel("Primary phone", { exact: true }).count(), 0);
    assert.equal(await page.getByLabel("Delivery notes", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("link", { name: "View order and reservations" }).getAttribute("href"), `/admin/orders/${id}`);
    await page.getByRole("dialog").getByRole("button", { name: "Copy", exact: true }).click();
    await page.waitForFunction(() => window.__copies.length === 1);
    state.order.resolvedDelivery.details.address = "NEW-ADDRESS";
    await page.getByRole("button", { name: "Prepare order" }).click();
    await page.getByRole("dialog").waitFor();
    assert.equal(await page.evaluate(() => window.__copies.length), 1);
    assert.match(await page.getByLabel("Message preview").inputValue(), /NEW-ADDRESS/);
    await page.getByRole("dialog").getByRole("button", { name: "Copy", exact: true }).click();
    await page.waitForFunction(() => window.__copies.length === 2);
    assert.match(await page.evaluate(() => window.__copies[1]), /NEW-ADDRESS/);
    assert.equal(state.requests.filter((r) => r.path.endsWith("fulfillment-sheet")).length, 2);
    assert.equal(state.requests.filter((r) => r.method !== "GET").length, 0);
  });
  await t.test("legacy destination is reviewed and saved to the order, then the updated sheet copies", async (t) => {
    const { page, state } = await fixture(t, { legacy: true });
    await page.getByRole("button", { name: "Prepare order" }).click();
    await page.getByRole("dialog").waitFor();
    assert.equal(await page.evaluate(() => window.__copies.length), 0);
    const close = page.getByRole("button", { name: "Close prepare order" });
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
      await page.getByRole("button", { name: "Prepare order" }).click();
      await page.getByRole("dialog").waitFor();
      const copy = page.getByRole("dialog").getByRole("button", { name: legacy ? "Save & Copy" : "Copy", exact: true });
      assert.equal(await copy.isEnabled(), true);
      await copy.click();
      await page.waitForFunction(() => window.__copies.length === 1);
      const text = await page.evaluate(() => window.__copies[0]);
      assert.match(text, /_Address:_ Order-only address/);
      assert.doesNotMatch(text, /Contact:|Phone:|Notes:|Grosgrain ribbon|Order Recipient/);
      assert.match(text, /_Assigned To:_ \*Ahmed\*/);
      assert.equal(state.requests.filter((r) => r.method === "PUT").length, legacy ? 1 : 0);
    }
  });
  await t.test("assignment is mandatory, saves on request, reopens and cannot be cleared", async (t) => {
    const { page, state } = await fixture(t, { assignedTo: "" });
    const open = async () => {
      await page.getByRole("button", { name: "Prepare order" }).click();
      await page.getByRole("dialog").waitFor();
    };
    await open();
    const assignee = page.getByLabel("Assigned To", { exact: true });
    assert.equal(await assignee.getAttribute("required"), "");
    assert.equal(await assignee.getAttribute("aria-invalid"), "true");
    assert.equal(await page.getByRole("dialog").getByRole("button", { name: "Copy", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Copy preparation draft", exact: true }).isDisabled(), true);
    await assignee.fill("   ");
    assert.equal(await page.getByRole("dialog").getByRole("button", { name: "Copy", exact: true }).isDisabled(), true);
    await page.getByLabel("Assigned To").fill("Unsaved name");
    await page.getByRole("button", { name: "Close prepare order", exact: true }).click();
    await open();
    assert.equal(await page.getByLabel("Assigned To").inputValue(), "");
    assert.equal(state.requests.filter((r) => r.method === "PUT").length, 0);
    const readsBefore = state.requests.filter((r) => r.path.endsWith("fulfillment-sheet")).length;
    await page.getByLabel("Assigned To").fill("  Ahmed  ");
    assert.match(await page.getByLabel("Message preview").inputValue(), /_Carton Tag:_ \*ABC-023AD\*\n_Assigned To:_ \*Ahmed\*/);
    assert.match(await page.getByLabel("Message preview").inputValue(), /^\*PREPARE & DELIVER\*/);
    assert.equal(state.requests.filter((r) => r.path.endsWith("fulfillment-sheet")).length, readsBefore);
    await page.getByRole("button", { name: "Save & Copy", exact: true }).click();
    await page.waitForFunction(() => window.__copies.length === 1);
    assert.equal(state.order.assignedTo, "Ahmed");
    assert.match(await page.evaluate(() => window.__copies[0]), /_Assigned To:_ \*Ahmed\*/);
    const write = state.requests.find((r) => r.method === "PUT");
    assert.equal(write.body.assignedTo, "Ahmed");
    assert.equal(write.body.deliveryDetails.contactName, "Order Recipient");
    assert.equal(write.body.deliveryDetails.phoneNumber, "+123456");
    assert.equal(write.body.deliveryDetails.notes, "Receiving hours");
    await open();
    assert.equal(await page.getByLabel("Assigned To").inputValue(), "Ahmed");
    for (const blank of ["", "   "]) {
      await page.getByLabel("Assigned To").fill(blank);
      assert.equal(await page.getByRole("button", { name: "Save & Copy", exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole("button", { name: "Save for this order", exact: true }).isDisabled(), true);
    }
    assert.equal(state.order.assignedTo, "Ahmed");
    assert.equal(state.requests.filter((r) => r.method === "PUT").length, 1);
    await page.getByLabel("Assigned To").fill("Samir");
    await page.getByRole("button", { name: "Save & Copy", exact: true }).click();
    await page.waitForFunction(() => window.__copies.length === 2);
    assert.equal(state.order.assignedTo, "Samir");
    assert.match(await page.evaluate(() => window.__copies[1]), /_Assigned To:_ \*Samir\*/);
    assert.equal(state.requests.filter((r) => r.method === "PUT").length, 2);
    assert.equal(state.requests.filter((r) => r.method === "PUT" && r.path.startsWith("/users/")).length, 0);
  });
  await t.test("draft copying requires and saves an assignee before copying", async (t) => {
    const { page, state } = await fixture(t, { assignedTo: "" });
    state.preparationProblems = ["Reservations need review before picking."];
    await page.getByRole("button", { name: "Prepare order" }).click();
    await page.getByRole("dialog").waitFor();
    assert.equal(await page.getByRole("button", { name: "Copy preparation draft", exact: true }).isDisabled(), true);
    await page.getByLabel("Assigned To").fill("Ahmed");
    await page.getByRole("button", { name: "Save & Copy Draft", exact: true }).click();
    await page.waitForFunction(() => window.__copies.length === 1);
    assert.equal(state.order.assignedTo, "Ahmed");
    assert.equal(state.requests.filter((r) => r.method === "PUT").length, 1);
    const text = await page.evaluate(() => window.__copies[0]);
    assert.match(text, /^\*PREPARATION DRAFT — HOLD\*/);
    assert.match(text, /_Assigned To:_ \*Ahmed\*/);
    assert.match(text, /Reservations need review/);
  });
  await t.test("a conflicting assignment preserves entered text and reloads the winning assignee", async (t) => {
    const { page, state } = await fixture(t, { assignedTo: "Existing worker" });
    await page.getByRole("button", { name: "Prepare order" }).click();
    await page.getByRole("dialog").waitFor();
    await page.getByLabel("Assigned To").fill("My edited worker");
    state.conflict = true;
    state.conflictAssignedTo = "Other worker";
    await page.getByRole("button", { name: "Save & Copy", exact: true }).click();
    await page.getByText("Order changed. Reload and review before saving.").first().waitFor();
    assert.equal(await page.getByLabel("Assigned To").inputValue(), "My edited worker");
    assert.equal(await page.evaluate(() => window.__copies.length), 0);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Reload details" }).click();
    await page.waitForFunction(() => document.querySelector("#order-assigned-to")?.value === "Other worker");
    await page.getByRole("dialog").getByRole("button", { name: "Copy", exact: true }).click();
    await page.waitForFunction(() => window.__copies.length === 1);
    assert.match(await page.evaluate(() => window.__copies[0]), /_Assigned To:_ \*Other worker\*/);
    assert.equal(state.requests.filter((r) => r.method === "PUT").length, 1);
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
  await t.test("clipboard retry keeps the saved assignee without another write or refresh", async (t) => {
    const { page, state } = await fixture(t, { mobile: true, assignedTo: "Samir" });
    await page.evaluate(() => { window.__copyFailure = true; });
    await page.getByRole("button", { name: "Prepare order" }).click();
    await page.getByRole("dialog").waitFor();
    await page.screenshot({ path: "/tmp/megadie-prepare-deliver-mobile-top.png", fullPage: true });
    assert.match(await page.getByLabel("Message preview").inputValue(), /^\*PREPARE & DELIVER\*\n_Order:_ ORD-261102-023AD\n_Carton Tag:_ \*ABC-023AD\*\n/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByLabel("Assigned To").fill("Ahmed");
    await page.getByRole("dialog").getByRole("button", { name: "Save & Copy", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Copy", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__copies.length), 0);
    assert.equal(state.order.assignedTo, "Ahmed");
    assert.equal(state.requests.filter((r) => r.method === "PUT").length, 1);
    // Dismiss the temporary clipboard-error toast before checking modal/navigation stacking.
    await page.locator(".Toastify__close-button").first().click();
    await page.locator(".Toastify__toast").waitFor({ state: "detached" });
    const close = page.getByRole("button", { name: "Close prepare order" });
    await page.screenshot({ path: "/tmp/megadie-delivery-mobile.png", fullPage: true });
    const hit = await close.evaluate((node) => { const r = node.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); const overlay = node.closest("[role=dialog]").parentElement; return { topmost: node.contains(hit), rect: r.toJSON(), hit: hit?.outerHTML.slice(0, 220), overlayZ: getComputedStyle(overlay).zIndex, parent: overlay.parentElement.tagName }; });
    assert.equal(hit.topmost, true, JSON.stringify(hit));
    await page.evaluate(() => { window.__copyFailure = false; });
    await page.getByRole("dialog").getByRole("button", { name: "Copy", exact: true }).click();
    await page.waitForFunction(() => window.__copies.length === 1);
    assert.equal(state.requests.filter((r) => r.path.endsWith("fulfillment-sheet")).length, 2);
    assert.equal(state.requests.filter((r) => r.method === "PUT").length, 1);
    assert.match(await page.evaluate(() => window.__copies[0]), /_Assigned To:_ \*Ahmed\*/);
  });
  await t.test("closed orders cannot initiate staff copying", async (t) => {
    for (const status of ["Delivered", "Cancelled"]) {
      const { page, state } = await fixture(t, { status });
      assert.equal(await page.getByRole("button", { name: "Prepare order" }).isDisabled(), true);
      assert.equal(state.requests.filter((r) => r.path.endsWith("fulfillment-sheet")).length, 0);
    }
  });
  await t.test("task must be chosen, preparation-only needs no location, and switching preserves the destination", async (t) => {
    const { page, state } = await fixture(t, { preparationMode: "" });
    await page.getByRole("button", { name: "Prepare order" }).click();
    await page.getByRole("dialog").waitFor();
    assert.equal(await page.getByLabel("Address", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("dialog").getByRole("button", { name: "Copy", exact: true }).isDisabled(), true);
    await page.getByRole("radio", { name: "Prepare & Deliver", exact: true }).check();
    await page.getByLabel("Address", { exact: true }).fill("");
    await page.getByLabel("Google Maps location").fill("");
    assert.equal(await page.getByRole("button", { name: "Save & Copy", exact: true }).isDisabled(), true);
    await page.getByLabel("Address", { exact: true }).fill("Do not share this destination");
    await page.getByRole("radio", { name: "Prepare Only", exact: true }).check();
    assert.equal(await page.getByLabel("Address", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("checkbox", { name: /Save as customer/ }).count(), 0);
    let preview = await page.getByLabel("Message preview").inputValue();
    assert.match(preview, /^\*PREPARE ONLY\*/);
    await page.screenshot({ path: "/tmp/megadie-prepare-only-desktop.png", fullPage: true });
    assert.doesNotMatch(preview, /DELIVER|Address|Map|Do not share|maps.app/);
    await page.getByRole("radio", { name: "Prepare & Deliver", exact: true }).check();
    assert.equal(await page.getByLabel("Address", { exact: true }).inputValue(), "Do not share this destination");
    await page.getByLabel("Address", { exact: true }).fill("");
    await page.getByRole("radio", { name: "Prepare Only", exact: true }).check();
    await page.getByRole("button", { name: "Save & Copy", exact: true }).click();
    await page.waitForFunction(() => window.__copies.length === 1);
    assert.equal(state.order.preparationMode, "prepare_only");
    assert.equal(state.order.resolvedDelivery.details.address, "");
    assert.doesNotMatch(await page.evaluate(() => window.__copies[0]), /DELIVER|Address|Map|maps.app/);
    await page.getByRole("button", { name: "Prepare order" }).click();
    await page.getByRole("dialog").waitFor();
    assert.equal(await page.getByRole("radio", { name: "Prepare Only", exact: true }).isChecked(), true);
    assert.equal(await page.getByLabel("Address", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("dialog").getByRole("button", { name: "Copy", exact: true }).isEnabled(), true);
  });
  await t.test("customer default can fill an older order and is updated only with explicit opt-in", async (t) => {
    const { page, state } = await fixture(t);
    state.customer.deliveryGoogleMapsUrl = "https://maps.app.goo.gl/default";
    await page.getByRole("button", { name: "Prepare order" }).click();
    await page.getByRole("dialog").waitFor();
    const checkbox = page.getByRole("checkbox", { name: /Save as customer's default location/ });
    assert.equal(await checkbox.isChecked(), false);
    await page.getByRole("button", { name: "Use customer's default", exact: true }).click();
    assert.equal(await page.getByLabel("Address", { exact: true }).inputValue(), "LIVE-PROFILE-ADDRESS");
    assert.equal(await page.getByLabel("Google Maps location").inputValue(), "https://maps.app.goo.gl/default");
    assert.equal(state.requests.filter((r) => r.method === "PUT").length, 0);
    await page.getByLabel("Address", { exact: true }).fill("New usual address");
    await checkbox.check();
    await page.getByRole("button", { name: "Save & Copy", exact: true }).click();
    await page.waitForFunction(() => window.__copies.length === 1);
    const write = state.requests.find((r) => r.method === "PUT");
    assert.equal(write.body.saveCustomerLocation, true);
    assert.deepEqual(write.body.expectedCustomerLocation, { address: "LIVE-PROFILE-ADDRESS", googleMapsUrl: "https://maps.app.goo.gl/default" });
    assert.equal(state.customer.address, "New usual address");
    assert.equal(write.body.deliveryDetails.contactName, "Order Recipient");
    await page.getByRole("button", { name: "Prepare order" }).click();
    await page.getByRole("dialog").waitFor();
    assert.equal(await checkbox.isChecked(), false);
    await page.getByLabel("Address", { exact: true }).fill("One-off delivery");
    await page.getByRole("button", { name: "Save & Copy", exact: true }).click();
    await page.waitForFunction(() => window.__copies.length === 2);
    assert.equal(state.customer.address, "New usual address");
    assert.equal(state.order.resolvedDelivery.details.address, "One-off delivery");
  });
  await t.test("changed customer defaults preserve the form on conflict and reload fresh values", async (t) => {
    const { page, state } = await fixture(t);
    await page.getByRole("button", { name: "Prepare order" }).click();
    await page.getByRole("dialog").waitFor();
    await page.getByLabel("Address", { exact: true }).fill("My new default");
    await page.getByRole("checkbox", { name: /Save as customer's default location/ }).check();
    state.customer.address = "Other admin's default";
    await page.getByRole("button", { name: "Save & Copy", exact: true }).click();
    await page.getByText("Customer default location changed. Reload details and review before saving.").first().waitFor();
    assert.equal(await page.getByLabel("Address", { exact: true }).inputValue(), "My new default");
    assert.equal(await page.evaluate(() => window.__copies.length), 0);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Reload details" }).click();
    await page.waitForFunction(() => document.querySelector("#courier-address")?.value === "Order-only address");
    await page.getByRole("button", { name: "Use customer's default", exact: true }).click();
    assert.equal(await page.getByLabel("Address", { exact: true }).inputValue(), "Other admin's default");
  });

  await t.test("default opt-in alone enables saving and clipboard retry does not repeat the customer update", async (t) => {
    const { page, state } = await fixture(t);
    await page.getByRole("button", { name: "Prepare order" }).click();
    await page.getByRole("dialog").waitFor();
    const checkbox = page.getByRole("checkbox", { name: /Save as customer's default location/ });
    await checkbox.check();
    await page.evaluate(() => { window.__copyFailure = true; });
    await page.getByRole("button", { name: "Save & Copy", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Copy", exact: true }).waitFor();
    assert.equal(await checkbox.isChecked(), false);
    assert.equal(state.customer.address, details.address);
    assert.equal(state.requests.filter((r) => r.method === "PUT").length, 1);
    await page.evaluate(() => { window.__copyFailure = false; });
    await page.getByRole("dialog").getByRole("button", { name: "Copy", exact: true }).click();
    await page.waitForFunction(() => window.__copies.length === 1);
    assert.equal(state.requests.filter((r) => r.method === "PUT").length, 1);
  });
  await t.test("failed refresh after saving a default requires review without repeating the customer save", async (t) => {
    const { page, state } = await fixture(t);
    await page.getByRole("button", { name: "Prepare order" }).click();
    await page.getByRole("dialog").waitFor();
    await page.getByRole("checkbox", { name: /Save as customer's default location/ }).check();
    state.failSheetAfterSave = true;
    await page.getByRole("button", { name: "Save & Copy", exact: true }).click();
    await page.getByText("Could not refresh the sheet. Reload details before copying final instructions.").first().waitFor();
    assert.equal(await page.evaluate(() => window.__copies.length), 0);
    assert.equal(await page.getByRole("dialog").getByRole("button", { name: "Copy", exact: true }).isDisabled(), true);
    assert.equal(state.requests.filter((r) => r.method === "PUT").length, 1);
    await page.getByRole("button", { name: "Reload details" }).click();
    const copy = page.getByRole("dialog").getByRole("button", { name: "Copy", exact: true });
    await copy.click();
    await page.waitForFunction(() => window.__copies.length === 1);
    assert.equal(state.requests.filter((r) => r.method === "PUT").length, 1);
  });

});
