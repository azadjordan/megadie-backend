import { packingUnassignLockReason } from "../utils/packingState.js";
import { openOrderTool } from './helpers/orderTools.mjs';
// Every API is intercepted. No database writes or real clipboard operations.
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const origin = process.env.PACKING_TEST_ORIGIN || "http://localhost:5173";
const orderId = "100000000000000000000001";
const workerId = "200000000000000000000001";
const sourceId = "300000000000000000000001";
const targetId = "400000000000000000000002";
const metadata = () => ({ sessionId: "fixture-staff-session", sessionExpiresAt: Date.now() + 1800000, sessionAbsoluteExpiresAt: Date.now() + 28800000, sessionServerTime: Date.now() });

test("worker packing browser interactions", { timeout: 120000 }, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  async function fixture(t, { admin = false, mobile = false, alternatives = true, published = true } = {}) {
    const context = await browser.newContext({ viewport: mobile ? { width: 320, height: 850 } : { width: 1280, height: 1000 } });
    t.after(() => context.close());
    await context.addInitScript(() => { window.__copies = []; Object.defineProperty(navigator, "clipboard", { value: { writeText: async text => { window.__copies.push(text); } }, configurable: true }); });
    const profile = { _id: admin ? "200000000000000000000002" : workerId, name: admin ? "Owner" : "Worker Ahmed", email: "staff@test.invalid", isAdmin: admin, isWorker: !admin, approvalStatus: "Approved" };
    const state = { orderQueries: [], writes: [], unexpected: [], denied: false, loseResponse: false, account: { _id: workerId, name: "Worker Ahmed", email: "worker@test.invalid", phoneNumber: "TEST-PHONE", isAdmin: false, isWorker: false, approvalStatus: "Approved", updatedAt: "2026-11-11T08:00:00.000Z" }, task: {
      orderId, orderNumber: "ORD-TEST-9E7D51", customerName: "Ahmed Trading", label: "Ahmed Trading — 9E7D51", status: "Shipping", version: 0, deliveryRevision: 0,
      worker: published ? { id: workerId, name: "Worker Ahmed", enabled: true } : null, sentAt: published ? "2026-11-11T08:00:00.000Z" : null,
      packedAt: null, packedBy: "", preparationMode: "prepare_only", delivery: null, deliveryDetails: { address: "Warehouse road", googleMapsUrl: "", notes: "" }, customerLocation: { address: "Warehouse road", googleMapsUrl: "" }, deliverySavedToOrder: true,
      handoverAt: null, reports: [], reportsVersion: 0, activity: [], problems: [],
      items: [{ productId: "product-1", sku: "RIB-RED-25MM", name: "Red satin ribbon 25 mm", unit: "100yd Roll", qty: 10, reservedQty: 10, pickedQty: 0,
        allocations: [{ allocationId: sourceId, slotId: "400000000000000000000001", slot: "A1-AE1", qty: 10, pickedQty: 0, problemQty: 0, status: "Reserved" }],
        alternatives: alternatives ? [{ slotId: targetId, slot: "B2-AE1", availableQty: 10 }] : [],
      }],
    } };
    function rebuild() {
      const task = state.task, p = task.items[0];
      p.reservedQty = p.allocations.reduce((sum, row) => sum + row.qty, 0);
      p.pickedQty = p.allocations.reduce((sum, row) => sum + row.pickedQty, 0);
      task.summary = { totalUnits: p.qty, pickedUnits: p.pickedQty, remainingUnits: Math.max(0, p.qty - p.pickedQty), totalItems: 1, collectedItems: p.pickedQty === p.qty ? 1 : 0, inProgressItems: p.pickedQty > 0 && p.pickedQty < p.qty ? 1 : 0, needsHelp: p.allocations.some(row => row.problemQty > 0) || p.reservedQty !== p.qty };
      if (!task.summary.needsHelp || !task.sentAt) p.helpRequestedAt = null;
      task.helpRequestedItems = p.helpRequestedAt ? 1 : 0;
      task.stockChecksPending = task.reports.filter(report => !report.checkedAt).length;
      task.canPack = Boolean(task.sentAt) && !task.packedAt && task.summary.collectedItems === 1 && !task.summary.needsHelp;
      if (admin) task.unassignLockReason = packingUnassignLockReason({ status: task.status, packingSentAt: task.sentAt, packedAt: task.packedAt, ...state.orderOverrides }, p.allocations, Boolean(state.invoice));
      return task;
    }
    const rawOrder = () => ({ _id: orderId, orderNumber: state.task.orderNumber, status: state.task.status, createdAt: "2026-11-11T08:00:00.000Z", user: { _id: "customer-1", name: "Ahmed Trading", email: "client@test.invalid" }, invoice: state.invoice || null, quote: null, orderItems: [{ product: { _id: "product-1", name: "Red satin ribbon 25 mm", sku: "RIB-RED-25MM" }, sku: "RIB-RED-25MM", qty: 10, unitPrice: 1 }], totalPrice: 10, deliveryCharge: 0, extraFee: 0, allocationStatus: "Allocated", preparationMode: "prepare_only", assignedTo: state.task.worker?.name || "", packingSentAt: state.task.sentAt, packedAt: state.task.packedAt, packingSummary: rebuild().summary, stockChecksPending: rebuild().stockChecksPending, helpRequestedItems: rebuild().helpRequestedItems, ...state.orderOverrides });
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (!url.pathname.startsWith("/api/")) return url.origin === origin ? route.continue() : route.abort();
      const path = url.pathname.slice(4), method = request.method();
      const headers = { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS" };
      const reply = (body, status = 200) => route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify(body) });
      if (method === "OPTIONS") return route.fulfill({ status: 204, headers });
      if (path === "/users/account/profile") return reply({ data: { ...profile, ...metadata(), ...state.session } });
      if (path === "/users/session/activity") {
        if (state.session) state.session.sessionExpiresAt = Math.min(state.session.sessionServerTime + 1800000, state.session.sessionAbsoluteExpiresAt);
        return reply({ data: { ...metadata(), ...state.session } });
      }
      if (path === `/users/${workerId}` && method === "GET") return reply({ data: state.account });
      if (path === `/users/${workerId}` && method === "PUT") { const body = request.postDataJSON(); state.writes.push({ action: "worker-access", body }); Object.assign(state.account, body, { updatedAt: new Date().toISOString() }); return reply({ data: state.account }); }
      if (path === `/user-prices/${workerId}` || path === "/price-rules") return reply({ data: [] });
      if (path === "/site-settings/maintenance-notice") return reply({ data: { enabled: false } });
      if (path === "/packing/workers") return reply({ data: [{ _id: workerId, name: "Worker Ahmed" }] });
      const deliveryTask = row => ({ ...row, worker: row.preparationMode === 'prepare_deliver' ? row.worker : null, delivery: row.preparationMode === 'prepare_deliver' ? row.delivery : null, items: row.preparationMode === 'prepare_deliver' ? row.items : [], deliveryState: row.packedAt ? 'ready' : 'waiting', canAssign: row.status === 'Shipping', canDepart: Boolean(row.packedAt && row.preparationMode === 'prepare_deliver'), canDeliver: false, canReturn: false, canCorrect: false, readyReason: row.packedAt ? '' : 'Waiting for packing.' });
      if (path === '/packing/deliveries' && method === 'GET') {
        const rows = (state.boardRows || (state.task.sentAt ? [rebuild()] : [])).filter(row => row.preparationMode === 'prepare_deliver');
        return reply({ data: rows.map(deliveryTask), pagination: { page: 1, total: rows.length, hasNext: false } });
      }
      if (/^\/packing\/deliveries\/[^/]+$/.test(path) && method === 'GET') {
        if (state.denied) return reply({ message: 'Task reassigned' }, 403);
        const row = state.boardRows?.find(row => row.orderId === path.split('/').at(-1)) || rebuild();
        return reply({ data: deliveryTask(row) });
      }
      if (path === "/packing/orders" && method === "GET") {
        if (state.listFailed) return reply({ message: "Cannot load" }, 503);
        if (state.holdList) await new Promise(resolve => { state.finishList = resolve; });
        const rows = state.boardRows || (state.task.sentAt ? [rebuild()] : []);
        const definitions = { to_pack: row => !row.packedAt, ready_delivery: row => row.packedAt && row.preparationMode === "prepare_deliver", ready_handoff: row => row.packedAt && row.preparationMode !== "prepare_deliver" };
        return reply({ groups: Object.fromEntries(Object.entries(definitions).map(([key, filter]) => {
          const matching = rows.filter(filter), page = Math.min(Number(url.searchParams.get(key + "Page")) || 1, Math.max(1, Math.ceil(matching.length / 12)));
          return [key, { data: matching.slice((page - 1) * 12, page * 12), pagination: { page, total: matching.length, hasNext: page * 12 < matching.length } }];
        })) });
      }
      if (path === `/packing/orders/${orderId}` && method === "GET") {
        if (state.denied) return reply({ message: "Task reassigned" }, 403);
        if (state.holdRead) { state.holdRead = false; const snapshot = structuredClone(rebuild()); await new Promise(resolve => { state.finishRead = resolve; }); return reply({ data: snapshot }); }
        return reply({ data: rebuild() });
      }
      if (path.startsWith(`/packing/orders/${orderId}/reports/`) && method === 'PATCH') {
        const body = request.postDataJSON(); state.writes.push({ action: 'review-stock', body });
        if (body.expectedReportsVersion !== state.task.reportsVersion) return reply({ message: 'Stock report checks changed. Refresh the latest reports before another change.' }, 409);
        const report = state.task.reports.find(report => report._id === path.split('/').at(-1));
        if (!report) return reply({ message: 'Stock report not found.' }, 404);
        if (body.checked) Object.assign(report, { checkedAt: '2026-11-13T08:00:00.000Z', checkedByName: 'Owner' });
        else { delete report.checkedAt; delete report.checkedByName; }
        state.task.reportsVersion++;
        if (state.loseReportResponse) { state.loseReportResponse = false; return route.abort('failed'); }
        return reply({ data: rebuild(), message: 'Stock report saved.' });
      }
      if (path === `/packing/orders/${orderId}/unassign` && method === 'POST') {
        const body = request.postDataJSON(); state.writes.push({ action: 'unassign', body });
        if (state.unassignConflict) {
          state.unassignConflict = false; state.task.items[0].allocations[0].pickedQty = 4; state.task.version++;
        }
        if (body.expectedRevision !== state.task.version || body.expectedDeliveryRevision !== state.task.deliveryRevision) return reply({ message: 'Order changed. Refresh packing progress and review before saving.' }, 409);
        if (body.confirmedPhysicalReturn !== true) return reply({ message: 'Confirm the worker has stopped and all goods are in their original slots.' }, 400);
        const task = rebuild();
        if (task.unassignLockReason) return reply({ message: task.unassignLockReason }, 409);
        task.sentAt = null; task.worker = null; task.handoverAt = null; task.version++; task.deliveryRevision++;
        task.activity.push({ action: 'ASSIGNMENT_REMOVED', actorName: 'Owner', at: new Date().toISOString() });
        if (state.loseUnassignResponse) { state.loseUnassignResponse = false; return route.abort('failed'); }
        await new Promise(resolve => setTimeout(resolve, state.delay || 40));
        return reply({ data: rebuild(), message: 'Packing worker removed. Reservations kept.' });
      }
      if (path.startsWith(`/packing/orders/${orderId}/`) && method === "POST") {
        const action = path.split("/").at(-1), body = request.postDataJSON();
        state.writes.push({ action, body });
        if (body.expectedRevision !== state.task.version) return reply({ message: "Order changed. Refresh packing progress." }, 409);
        const task = state.task, p = task.items[0], row = p.allocations.find(row => row.allocationId === body.allocationId);
        if (action === 'replace' && state.replaceConflict) { state.replaceConflict = false; p.alternatives[0].availableQty = 0; return reply({ message: 'This location is no longer available. Your picked count is saved.' }, 409); }
        if (action === 'packed' && state.packingConflict) { state.packingConflict = false; p.allocations[0].pickedQty = 9; task.version++; return reply({ message: 'Order changed. Check latest progress.' }, 409); }
        if (action === 'pick' && row?.problemQty > 0) return reply({ message: 'This slot was reported short. Review the shortage and enter the actual picked total.' }, 409);
        if (action === "send") { task.sentAt = "2026-11-11T08:00:00.000Z"; task.worker = { id: body.workerId, name: "Worker Ahmed", enabled: true }; task.preparationMode = body.preparationMode; task.deliveryDetails = structuredClone(body.deliveryDetails); task.delivery = body.preparationMode === 'prepare_deliver' ? structuredClone(body.deliveryDetails) : null; task.deliveryRevision++; }
        else if (action === "pick" || action === "problem" || action === "correct") {
          row.pickedQty = body.pickedQty;
          if (action === "problem") { row.problemQty = row.qty - row.pickedQty; task.reportsVersion++; task.reports.push({ _id: "report-1", sku: p.sku, slotLabel: row.slot, slot: row.slotId, pickedQty: row.pickedQty, requestedQty: row.qty, shortQty: row.problemQty, byName: profile.name, at: "2026-11-11T08:00:00.000Z" }); }
          if (row.qty === row.pickedQty) row.problemQty = 0;
        } else if (action === "replace") {
          row.qty -= body.qty; row.problemQty = Math.max(0, row.qty - row.pickedQty);
          p.allocations.push({ allocationId: "300000000000000000000002", slotId: targetId, slot: "B2-AE1", qty: body.qty, pickedQty: 0, problemQty: 0, status: "Reserved" });
          p.alternatives[0].availableQty -= body.qty;
        } else if (action === "help") { p.helpRequestedAt ||= '2026-11-11T08:00:00.000Z'; }
        else if (action === "packed") { task.packedAt = "2026-11-11T08:30:00.000Z"; task.packedBy = profile.name; }
        else if (action === "reopen") { task.packedAt = null; task.packedBy = ""; }
        if (['problem', 'replace'].includes(action) && p.allocations.some(row => row.problemQty > 0) && !p.alternatives.some(candidate => candidate.availableQty > 0)) p.helpRequestedAt ||= '2026-11-11T08:00:00.000Z';
        task.version++;
        if (state.loseResponse || (action === "help" && state.loseHelpResponse)) { state.loseResponse = false; state.loseHelpResponse = false; return route.abort("failed"); }
        await new Promise(resolve => setTimeout(resolve, state.delay || 40));
        return reply({ data: rebuild(), message: action === "packed" ? "Order marked Packed." : action === "send" ? "Order sent to worker." : "Saved." });
      }
      if (path === `/orders/${orderId}/delete-preview`) {
        state.previewReads = (state.previewReads || 0) + 1;
        if (state.deleted) return reply({ message: "Order not found." }, 404);
        const p = rebuild().items[0], blockers = state.deleteBlockers || [];
        return reply({ data: { allowed: !blockers.length, blockers, confirmText: state.task.orderNumber,
          order: { id: orderId, orderNumber: state.task.orderNumber, status: state.task.status, version: state.task.version },
          stock: { requiresPhysicalReturn: Boolean(state.task.sentAt), reservedQty: p.reservedQty, deductedQty: 0, pickedQty: p.pickedQty,
            returnRows: p.allocations.filter(row => row.pickedQty > 0).map(row => ({ allocationId: row.allocationId, sku: p.sku, productName: p.name, slotLabel: row.slot, qty: row.pickedQty, unit: p.unit })),
          }, allocations: { total: p.allocations.length }, invoice: { exists: false }, payments: { count: 0 },
          actions: ["Record confirmed picked-stock returns", "Release reservations", "Delete order"], warnings: [],
        } });
      }
      if (path === `/orders/${orderId}` && method === "DELETE") {
        const body = request.postDataJSON(); state.writes.push({ action: "delete", body });
        if (body.expectedRevision !== state.task.version) return reply({ message: "Order changed. Refresh the delete preview and confirm the latest stock return before deleting." }, 409);
        if (state.deleteBlockers?.length) return reply({ message: state.deleteBlockers.join(" ") }, 409);
        if (state.task.sentAt && body.confirmedPhysicalReturn !== true) return reply({ message: "Confirm goods returned." }, 409);
        state.deleted = true;
        if (state.loseDeleteResponse) return route.abort("failed");
        await new Promise(resolve => setTimeout(resolve, state.delay || 40));
        return reply({ data: { stockRestored: false, releasedQty: 10, returnedPickedQty: state.task.items[0].pickedQty }, message: "Order deleted." });
      }
      if (path === '/slot-items/by-product/product-1') return reply({ data: [{ _id: 'stock-1', product: 'product-1', slot: { _id: '400000000000000000000001', label: 'A1-AE1', store: 'AE1', isActive: true }, qty: 20, reservedQty: 10, availableQty: 10 }] });
      if (path === `/orders/${orderId}`) return reply({ data: rawOrder() });
      if (path === `/orders/${orderId}/allocations`) return reply({ data: state.task.items[0].allocations.map(row => ({ _id: row.allocationId, product: { _id: "product-1", name: "Ribbon", sku: "RIB-RED-25MM" }, slot: { _id: row.slotId, label: row.slot }, qty: row.qty, status: "Reserved" })) });
      if (path === `/invoices/from-order/${orderId}` && method === 'POST') {
        state.writes.push({ action: 'create-invoice', body: request.postDataJSON() });
        if (state.holdInvoice) await new Promise(resolve => { state.finishInvoice = resolve; });
        if (state.invoiceError) return reply({ message: state.invoiceError }, 409);
        state.invoice = { _id: '500000000000000000000001', invoiceNumber: 'INV-TEST-1', status: 'Issued', paymentStatus: 'Unpaid', amountMinor: 1000, paidTotalMinor: 0, balanceDueMinor: 1000, currency: 'AED', minorUnitFactor: 100 };
        return reply({ data: state.invoice, message: 'Invoice created.' }, 201);
      }
      if (path === `/orders/${orderId}/movement` && method === 'GET') return reply({ data: { orderId, orderNumber: state.task.orderNumber, status: state.task.status, version: state.task.version, manualPreparation: !state.task.sentAt, readyReason: '', isOut: false, holdsGoods: false, movement: null, history: [] } });
      if (path === "/orders/work-summary") return reply({ data: { all: state.deleted ? 0 : 1, needsAdmin: rebuild().helpRequestedItems > 0 ? 1 : 0, preparation: !state.task.packedAt ? 1 : 0, toInvoice: state.task.packedAt && !state.invoice ? 1 : 0, toDeliver: state.task.packedAt && state.invoice ? 1 : 0, toFinalize: 0, needsStockCheck: rebuild().stockChecksPending > 0 ? 1 : 0, ...state.summaryOverrides } });
      if (path === "/orders") {
        state.orderQueries.push(Object.fromEntries(url.searchParams));
        if (state.ordersFailed) return reply({ message: 'Orders temporarily unavailable' }, 503);
        if (state.emptyLastPage && url.searchParams.get('page') === '2') return reply({ data: [], pagination: { page: 2, totalPages: 1, total: 1, limit: 10 } });
        return reply({ data: state.deleted || (url.searchParams.get('work') === 'noInvoice' && state.invoice) ? [] : state.listRows || [rawOrder()], pagination: state.orderPagination || { page: 1, totalPages: 1, total: 1, limit: 10 } });
      }
      state.unexpected.push({ path, method }); return reply({ message: `Unexpected API ${method} ${path}` }, 500);
    });
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    t.after(() => { assert.deepEqual(state.unexpected, []); assert.deepEqual(errors, []); });
    return { page, state, context };
  }

  for (const mobile of [false, true]) await t.test(`assignment removal returns to manual preparation with reservations and reports on ${mobile ? 'mobile' : 'desktop'}`, async t => {
    const { page, state } = await fixture(t, { admin: true, mobile });
    state.task.reports = [{ _id: 'report-1', sku: 'RIB-RED-25MM', slotLabel: 'A1-AE1', pickedQty: 0, shortQty: 10 }];
    await page.goto(`${origin}/admin/orders?limit=20&work=preparation`);
    await openOrderTool(page, 'Packing worker');
    await page.getByRole('button', { name: 'Remove packing assignment', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove packing assignment', exact: true });
    const remove = dialog.getByRole('button', { name: 'Remove assignment', exact: true });
    assert.equal(await remove.isDisabled(), true);
    assert.equal(state.writes.length, 0);
    await dialog.getByRole('checkbox', { name: 'The worker has stopped, and all goods are in their original slots.', exact: true }).check();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Remove assignment' && !button.disabled));
    await page.screenshot({ path: `/Users/azad/Developer/megadie/output/remove-worker-${mobile ? 'mobile' : 'desktop'}.png`, fullPage: true });
    await remove.evaluate(button => { button.click(); button.click(); });
    await page.waitForURL(url => url.pathname === `/admin/orders/${orderId}` && url.searchParams.get('tab') === 'stock');
    assert.equal(new URL(page.url()).searchParams.get('work'), 'preparation');
    assert.equal(new URL(page.url()).searchParams.get('limit'), '20');
    assert.equal(state.writes.filter(write => write.action === 'unassign').length, 1);
    assert.equal(state.writes[0].body.confirmedPhysicalReturn, true);
    assert.equal(state.task.sentAt, null); assert.equal(state.task.worker, null);
    assert.equal(state.task.items[0].reservedQty, 10); assert.equal(state.task.reports.length, 1);
    const summary = page.getByRole('region', { name: 'Packing summary', exact: true });
    await summary.getByRole('link', { name: /Packing history/ }).waitFor();
    await summary.getByRole('link', { name: 'Stock check needed (1)', exact: true }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.goto(`${origin}/admin/orders`);
    await page.getByRole('button', { name: /^More actions for / }).first().click();
    await page.getByRole('menuitem', { name: 'Manual packing message', exact: true }).waitFor();
  });

  await t.test('picked goods and completed packing keep assignment removal disabled with a reason', async t => {
    const { page, state } = await fixture(t, { admin: true });
    state.task.items[0].allocations[0].pickedQty = 4;
    await page.goto(`${origin}/admin/orders`); await openOrderTool(page, 'Packing worker');
    assert.equal(await page.getByRole('button', { name: 'Remove packing assignment', exact: true }).isDisabled(), true);
    await page.getByText('Return the picked goods to their original slots and correct the picked quantities to zero first.', { exact: true }).waitFor();
    assert.equal(state.writes.length, 0);
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    state.task.items[0].allocations[0].pickedQty = 10; state.task.packedAt = new Date().toISOString();
    await page.reload(); await openOrderTool(page, 'Packing worker');
    assert.equal(await page.getByRole('button', { name: 'Remove packing assignment', exact: true }).isDisabled(), true);
    await page.getByText('Packing is complete. Reopen packing before removing the assignment.', { exact: true }).waitFor();
  });

  await t.test('a new pick invalidates removal confirmation and requires a fresh review', async t => {
    const { page, state } = await fixture(t, { admin: true, mobile: true });
    await page.goto(`${origin}/admin/orders`); await openOrderTool(page, 'Packing worker');
    await page.getByRole('button', { name: 'Remove packing assignment', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove packing assignment', exact: true });
    const checkbox = dialog.getByRole('checkbox'); await checkbox.check();
    state.unassignConflict = true;
    await dialog.getByRole('button', { name: 'Remove assignment', exact: true }).click();
    await dialog.getByRole('button', { name: 'Check latest progress', exact: true }).waitFor();
    assert.equal(await checkbox.isChecked(), false);
    assert.equal(await dialog.getByRole('button', { name: 'Remove assignment', exact: true }).isDisabled(), true);
    await dialog.getByRole('button', { name: 'Check latest progress', exact: true }).click();
    await dialog.getByText('Return the picked goods to their original slots and correct the picked quantities to zero first.', { exact: true }).waitFor();
    assert.equal(await checkbox.isChecked(), false);
    assert.equal(await checkbox.isDisabled(), true);
    assert.equal(state.writes.filter(write => write.action === 'unassign').length, 1);
    assert.ok(state.task.worker); assert.equal(state.task.items[0].pickedQty, 4);
  });

  await t.test('a lost removal response checks saved state without submitting removal again', async t => {
    const { page, state } = await fixture(t, { admin: true });
    await page.goto(`${origin}/admin/orders`); await openOrderTool(page, 'Packing worker');
    await page.getByRole('button', { name: 'Remove packing assignment', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove packing assignment', exact: true });
    await dialog.getByRole('checkbox').check(); state.loseUnassignResponse = true;
    await dialog.getByRole('button', { name: 'Remove assignment', exact: true }).click();
    await dialog.getByRole('button', { name: 'Check latest progress', exact: true }).click();
    await page.waitForURL(url => url.pathname === `/admin/orders/${orderId}` && url.searchParams.get('tab') === 'stock');
    assert.equal(state.writes.filter(write => write.action === 'unassign').length, 1);
    assert.equal(state.task.sentAt, null);
  });

  await t.test('order details opens the same assignment removal flow and Back keeps it assigned', async t => {
    const { page, state } = await fixture(t, { admin: true });
    await page.goto(`${origin}/admin/orders/${orderId}`);
    await page.getByRole('region', { name: 'Packing summary', exact: true }).getByRole('button', { name: 'Packing worker', exact: true }).click();
    await page.getByRole('button', { name: 'Remove packing assignment', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('dialog', { name: 'Packing worker', exact: true }).waitFor();
    assert.ok(state.task.sentAt); assert.equal(state.writes.length, 0);
  });

  await t.test("worker landing, partial collection, replacement and packing survive a page reload", async t => {
    const { page, state } = await fixture(t, { mobile: true });
    await page.goto(`${origin}/`);
    await page.getByRole("heading", { name: "My work" }).waitFor();
    await page.getByRole("link", { name: /^Start packing for/ }).click();
    await page.getByRole("button", { name: "Not enough here", exact: true }).waitFor();
    await page.screenshot({ path: "/Users/azad/Developer/megadie/output/worker-packing-refined-checklist.png", fullPage: true });
    await page.getByRole("button", { name: "Not enough here", exact: true }).click();
    await page.getByLabel("How many did you take this time?", { exact: true }).fill("6");
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent.startsWith("Continue at B2-AE1") && !button.disabled));
    await page.screenshot({ path: "/Users/azad/Developer/megadie/output/worker-packing-refined-problem-entry.png", fullPage: true });
    await page.getByRole("button", { name: "Continue at B2-AE1 — 4 × 100yd Roll", exact: true }).waitFor();
    await page.screenshot({ path: "/Users/azad/Developer/megadie/output/worker-packing-refined-replacement.png", fullPage: true });
    await page.getByRole("button", { name: "Continue at B2-AE1 — 4 × 100yd Roll", exact: true }).click();
    await page.getByText("Picked 6 of 6", { exact: true }).waitFor();
    await page.getByRole("button", { name: /^Picked (all|remaining) /, exact: true }).click();
    await page.getByRole("button", { name: "Mark packed", exact: true }).click();
    await page.getByText(/^Packed by Worker Ahmed/).waitFor();
    assert.equal(await page.getByRole("button", { name: /^Picked (all|remaining) / }).count(), 0);
    await page.reload(); await page.getByText(/^Packed by Worker Ahmed/).waitFor();
    assert.deepEqual(state.writes.map(write => write.action), ["problem", "replace", "pick", "packed"]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: "/Users/azad/Developer/megadie/output/worker-packing-refined-mobile.png", fullPage: true });
  });
  await t.test("a shortage without an alternative stays visible and blocks Packed", async t => {
    const { page, state } = await fixture(t, { alternatives: false });
    await page.goto(`${origin}/packing/orders/${orderId}`);
    await page.getByRole("button", { name: "Not enough here", exact: true }).click();
    await page.getByLabel("How many did you take this time?", { exact: true }).fill("0");
    await page.getByRole("button", { name: "Ask admin for help", exact: true }).click();
    await page.getByText("No available replacement.", { exact: true }).waitFor();
    await page.getByRole("dialog").getByRole("button", { name: "Update picked total", exact: true }).click();
    await page.getByLabel(/^How many have you picked from/).fill("6");
    await page.getByRole("button", { name: "Save picked total", exact: true }).click();
    await page.getByText("Picked 6 of 10", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Mark packed", exact: true }).isDisabled(), true);
    assert.equal(state.task.summary.needsHelp, true);
  });
  await t.test('reported-short slots require an explicit picked total and keep their missing quantity clear', async t => {
    const { page, state } = await fixture(t, { alternatives: false, mobile: true });
    await page.goto(`${origin}/packing/orders/${orderId}`);
    await page.getByRole('button', { name: 'Picked all 10', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Not enough here', exact: true }).click();
    await page.getByLabel('How many did you take this time?', { exact: true }).fill('3');
    assert.equal(await page.getByRole('checkbox').count(), 0);
    if (await page.getByLabel('How many did you take this time?', { exact: true }).inputValue() === '') await page.getByLabel('How many did you take this time?', { exact: true }).fill('0');
    await page.getByRole('button', { name: 'Ask admin for help', exact: true }).click();
    await page.getByRole('button', { name: 'Continue picking', exact: true }).click();
    await page.getByText('No other slots are ready to pick. Admin help has been requested.', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: /^Picked (all|remaining) / }).count(), 0);
    await page.getByRole('group', { name: 'Location A1-AE1 for RIB-RED-25MM', exact: true }).getByText('7 × 100yd Roll missing', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Review shortage', exact: true }).click();
    await page.getByRole('button', { name: 'Update picked total', exact: true }).click();
    await page.getByLabel(/^How many have you picked from/).fill('10');
    await page.getByRole('button', { name: 'Save picked total', exact: true }).click();
    await page.getByText('Picked 10 of 10', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Mark packed', exact: true }).isDisabled(), false);
    assert.equal(state.task.items[0].pickedQty, 10);
    assert.deepEqual(state.writes.map(write => write.action), ['problem', 'problem']);
  });
  await t.test('continue picking skips shortages, unavailable locations and completed rows, then wraps to earlier work', async t => {
    const { page, state } = await fixture(t, { alternatives: false });
    const product = state.task.items[0], source = product.allocations[0];
    product.qty = 30;
    product.allocations = [
      { ...source, allocationId: 'before', slotId: 'before-slot', slot: 'A0-AE1', qty: 5 }, source,
      { ...source, allocationId: 'other-short', slotId: 'short-slot', slot: 'C1-AE1', qty: 5, problemQty: 5 },
      { ...source, allocationId: 'inactive', slotId: 'inactive-slot', slot: 'D1-AE1', qty: 5, canPick: false },
      { ...source, allocationId: 'after', slotId: 'after-slot', slot: 'E1-AE1', qty: 5 },
    ];
    await page.goto(`${origin}/packing/orders/${orderId}`);
    const original = page.getByRole('group', { name: 'Location A1-AE1 for RIB-RED-25MM', exact: true });
    await original.getByRole('button', { name: 'Not enough here', exact: true }).click();
    if (await page.getByLabel('How many did you take this time?', { exact: true }).inputValue() === '') await page.getByLabel('How many did you take this time?', { exact: true }).fill('0');
    await page.getByRole('button', { name: 'Ask admin for help', exact: true }).click();
    await page.getByRole('button', { name: 'Continue picking', exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Location E1-AE1 for RIB-RED-25MM');
    await page.getByRole('group', { name: 'Location E1-AE1 for RIB-RED-25MM', exact: true }).getByRole('button', { name: 'Picked all 5', exact: true }).click();
    await original.getByRole('button', { name: 'Review shortage', exact: true }).click();
    await page.getByRole('button', { name: 'Continue picking', exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Location A0-AE1 for RIB-RED-25MM');
    assert.deepEqual(state.writes.map(write => write.action), ['problem', 'pick']);
    assert.equal(state.task.items[0].allocations.find(row => row.allocationId === 'before').pickedQty, 0);
  });
  await t.test('a blocked-work message clears when the admin resolves the shortage', async t => {
    const { page, state } = await fixture(t, { alternatives: false });
    await page.goto(`${origin}/packing/orders/${orderId}`);
    await page.getByRole('button', { name: 'Not enough here', exact: true }).click();
    await page.getByLabel('How many did you take this time?', { exact: true }).fill('3');
    if (await page.getByLabel('How many did you take this time?', { exact: true }).inputValue() === '') await page.getByLabel('How many did you take this time?', { exact: true }).fill('0');
    await page.getByRole('button', { name: 'Ask admin for help', exact: true }).click();
    await page.getByRole('button', { name: 'Continue picking', exact: true }).click();
    await page.getByRole('link', { name: 'Choose another order', exact: true }).waitFor();
    state.task.version++; state.task.items[0].qty = 3;
    Object.assign(state.task.items[0].allocations[0], { qty: 3, pickedQty: 3, problemQty: 0 });
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByText('All units picked. Pack and label the carton, then finish.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Choose another order', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Mark packed', exact: true }).isDisabled(), false);
  });
  await t.test("an uncertain save requires a read before another write and retains a committed collection", async t => {
    const { page, state } = await fixture(t);
    await page.goto(`${origin}/packing/orders/${orderId}`);
    state.loseResponse = true;
    await page.getByRole("button", { name: /^Picked (all|remaining) /, exact: true }).click();
    await page.getByRole("button", { name: "Check latest progress", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: /^Picked (all|remaining) /, exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "Check latest progress", exact: true }).click();
    await page.getByText("Picked 10 of 10", { exact: true }).waitFor();
    assert.equal(state.writes.length, 1);
  });
  await t.test("worker help is explicit when alternatives are unusable and remains visible after reload and on the order card", async t => {
    const { page, state } = await fixture(t, { mobile: true });
    await page.goto(`${origin}/packing/orders/${orderId}`);
    await page.getByRole('button', { name: "Not enough here", exact: true }).click();
    await page.getByLabel('How many did you take this time?', { exact: true }).fill('6');
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Ask admin for help', exact: true }).click();
    await dialog.getByText('Admin help requested.', { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Ask admin for help', exact: true }).count(), 0);
    await dialog.getByRole('button', { name: 'Continue picking', exact: true }).click();
    await page.reload();
    await page.getByRole('article', { name: 'RIB-RED-25MM', exact: true }).getByText('Admin help requested', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Mark packed', exact: true }).isDisabled(), true);
    await page.getByRole('link', { name: 'Back to orders', exact: true }).click();
    await page.getByText('Admin help requested', { exact: true }).waitFor();
    assert.deepEqual(state.writes.map(write => write.action), ['problem', 'help']);
  });
  await t.test("an uncertain help response is recovered by reading without sending another help request", async t => {
    const { page, state } = await fixture(t);
    await page.goto(`${origin}/packing/orders/${orderId}`);
    await page.getByRole('button', { name: "Not enough here", exact: true }).click();
    await page.getByLabel('How many did you take this time?', { exact: true }).fill('0');
    state.loseHelpResponse = true;
    await page.getByRole('button', { name: 'Ask admin for help', exact: true }).click();
    await page.getByRole('button', { name: 'Check latest progress', exact: true }).click();
    await page.getByRole('dialog').getByText('Admin help requested.', { exact: true }).waitFor();
    assert.deepEqual(state.writes.map(write => write.action), ['problem', 'help']);
  });
  await t.test("worker sees specific order changes without financial details or extra acknowledgement", async t => {
    const { page, state } = await fixture(t);
    Object.assign(state.task, { itemsRevision: 1, itemsChangedBy: 'Owner', itemsChangedAt: '2026-11-11T09:00:00.000Z', itemsChanges: [{ productId: 'product-1', sku: 'RIB-RED-25MM', fromQty: 10, toQty: 6, unit: '100yd Roll' }, { productId: 'old-product', sku: 'OLD-SKU', fromQty: 37, toQty: 0, unit: 'units' }] });
    state.task.items[0].qty = 6; Object.assign(state.task.items[0].allocations[0], { qty: 6, pickedQty: 6 });
    await page.goto(`${origin}/packing/orders/${orderId}`);
    await page.getByText('RIB-RED-25MM: Order quantity changed from 10 to 6 × 100yd Roll. This item is complete.', { exact: true }).waitFor();
    await page.getByText('OLD-SKU: Item removed from this order.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Mark packed', exact: true }).isDisabled(), false);
    assert.equal(await page.getByText(/unit price|AED/i).count(), 0);
  });
  await t.test("a saved shortage panel refreshes to show an admin resolution while a worker is viewing it", async t => {
    const { page, state } = await fixture(t);
    await page.clock.install();
    await page.goto(`${origin}/packing/orders/${orderId}`);
    await page.getByRole('button', { name: "Not enough here", exact: true }).click();
    await page.getByLabel('How many did you take this time?', { exact: true }).fill('6');
    await page.getByRole('button', { name: 'Ask admin for help', exact: true }).click();
    await page.getByRole('dialog').getByText('Admin help requested.', { exact: true }).waitFor();
    state.task.version++; state.task.items[0].qty = 6;
    Object.assign(state.task.items[0].allocations[0], { qty: 6, pickedQty: 6, problemQty: 0 });
    await page.clock.fastForward(16000);
    await page.getByRole('dialog').getByText("This slot's shortage is resolved. Review the latest picking list.", { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: /^Use B2-AE1/ }).count(), 0);
    await page.getByRole('button', { name: 'Back to checklist', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Mark packed', exact: true }).isDisabled(), false);
  });
  await t.test("correcting a collection requires the physical return acknowledgement", async t => {
    const { page, state } = await fixture(t, { mobile: true });
    await page.goto(`${origin}/packing/orders/${orderId}`);
    await page.getByRole("button", { name: /^Picked (all|remaining) /, exact: true }).click();
    await page.getByRole("button", { name: "Correct count", exact: true }).click();
    await page.getByLabel(/^How many have you picked from/).fill("6");
    await page.getByRole('dialog').getByText('Already recorded: 10. Enter the actual total, including earlier picks.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog').getByText('Missing', { exact: true }).count(), 0);
    await page.screenshot({ path: '/Users/azad/Developer/megadie/output/worker-correct-count-mobile.png', fullPage: true });
    await page.getByRole("button", { name: "Save picked total", exact: true }).click();
    await page.getByText("Confirm that you put the items back or corrected an earlier wrong count.", { exact: true }).waitFor();
    assert.equal(state.writes.length, 1);
    await page.getByLabel("I put 4 back in A1-AE1, or the earlier count was wrong.", { exact: true }).check();
    await page.getByRole('dialog').getByText('Add a note', { exact: true }).click();
    await page.getByRole('dialog').getByLabel('Note (optional)', { exact: true }).fill('Returned four units to their original slot.');
    await page.getByRole("button", { name: "Save picked total", exact: true }).click();
    await page.getByText("Picked 6 of 10", { exact: true }).waitFor();
    assert.equal(state.writes[1].body.confirmedReturn, true);
    assert.equal(state.writes[1].body.note, 'Returned four units to their original slot.');
  });
  await t.test("losing assignment clears protected task details and actions", async t => {
    const { page, state } = await fixture(t);
    await page.goto(`${origin}/packing/orders/${orderId}`);
    await page.getByRole("heading", { name: "Ahmed Trading", exact: true }).waitFor();
    state.denied = true;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByText(/This task is no longer available/).waitFor();
    assert.equal(await page.getByRole("heading", { name: "Ahmed Trading", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Not enough here", exact: true }).count(), 0);
  });
  await t.test("admin can send an existing fully reserved order without using WhatsApp", async t => {
    const { page, state } = await fixture(t, { admin: true, published: false });
    await page.goto(`${origin}/admin/orders/${orderId}`);
    await page.getByRole("button", { name: "Send to worker", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Send to worker", exact: true });
    await dialog.getByRole("button", { name: "Send to worker", exact: true }).click();
    await page.getByText("Order sent to worker.", { exact: true }).waitFor();
    assert.equal(state.writes[0].body.workerId, workerId);
    assert.equal(state.writes[0].body.preparationMode, "prepare_only");
    await page.getByRole("dialog", { name: "Packing worker", exact: true }).getByRole("button", { name: "Copy worker link", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.__copies), [`${origin}/packing/orders/${orderId}`]);
    await page.screenshot({ path: "/Users/azad/Developer/megadie/output/worker-packing-refined-assignment.png", fullPage: true });
  });
  await t.test('invoice creation waits for live packing and publication explains existing billing locks', async t => {
    const { page, state } = await fixture(t, { admin: true });
    await page.goto(`${origin}/admin/orders/${orderId}?tab=invoice`);
    await page.getByRole('button', { name: 'Create Invoice', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Create Invoice', exact: true }).isDisabled(), true);
    await page.getByText('Finish worker packing before creating the invoice. Resolve shortages and mark the order Packed first.', { exact: true }).waitFor();
    state.task.packedAt = '2026-11-13T08:00:00.000Z'; state.task.version++;
    await page.reload(); assert.equal(await page.getByRole('button', { name: 'Create Invoice', exact: true }).isDisabled(), false);
    state.task.sentAt = null; state.task.worker = null; state.task.packedAt = null;
    state.task.sendLockReason = 'This order already has an invoice. Live packing must start before invoicing. Resolve its billing first, or continue its existing preparation process.';
    await page.goto(`${origin}/admin/orders/${orderId}/packing`);
    await page.getByRole('button', { name: 'Send to worker', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Send to worker', exact: true });
    await dialog.getByText(state.task.sendLockReason, { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Send to worker', exact: true }).isDisabled(), true);
    assert.equal(state.writes.length, 0);
  });
  for (const mobile of [false, true]) {
    await t.test(`a packed order has one working Invoice action and refreshes to Deliver on ${mobile ? 'mobile' : 'desktop'}`, async t => {
      const { page, state } = await fixture(t, { admin: true, mobile });
      state.task.packedAt = '2026-11-13T08:00:00.000Z';
      state.task.items[0].allocations[0].pickedQty = 10;
      await page.goto(`${origin}/admin/orders`);
      const invoice = page.getByRole('button', { name: 'Create invoice', exact: true });
      await invoice.waitFor(); assert.equal(await invoice.count(), 1);
      await page.getByRole('button', { name: 'To invoice 1', exact: true }).waitFor();
      await page.screenshot({ path: `/Users/azad/Developer/megadie/output/admin-single-invoice-${mobile ? 'mobile' : 'desktop'}.png`, fullPage: true });
      await invoice.click();
      const dialog = page.getByRole('dialog', { name: 'Create invoice', exact: true });
      await dialog.waitFor();
      state.holdInvoice = true;
      await dialog.getByRole('button', { name: 'Create invoice', exact: true }).dblclick();
      const saving = dialog.getByRole('button', { name: 'Creating...', exact: true });
      await saving.waitFor(); assert.equal(await saving.isDisabled(), true);
      assert.equal(state.writes.filter(write => write.action === 'create-invoice').length, 1);
      assert.equal(await page.getByRole('button', { name: 'Mark out for delivery', exact: true }).count(), 0);
      state.finishInvoice();
      await dialog.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Mark out for delivery', exact: true }).waitFor();
      await page.getByRole('button', { name: 'To invoice 0', exact: true }).waitFor();
      assert.equal(await invoice.count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Record payment', exact: true }).count(), 0);
      await page.getByRole('button', { name: /^More actions for / }).click();
      assert.equal(await page.getByRole('menuitem', { name: 'Record payment', exact: true }).isEnabled(), true);
      await page.keyboard.press('Escape');
      assert.equal(state.writes.filter(write => write.action === 'create-invoice').length, 1);
      assert.equal(state.task.status, 'Shipping');
      await page.getByRole('button', { name: 'Mark out for delivery', exact: true }).click();
      const delivery = page.getByRole('dialog', { name: 'Mark out for delivery', exact: true });
      await delivery.waitFor();
      await delivery.getByRole('button', { name: 'Close', exact: true }).click();
      await openOrderTool(page, 'Record payment');
      await page.getByRole('dialog', { name: 'Add payment', exact: true }).waitFor();
      await page.getByRole('dialog', { name: 'Add payment', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
      state.invoice.paymentStatus = 'Paid'; state.invoice.balanceDueMinor = 0; state.invoice.paidTotalMinor = 1000;
      await page.reload(); await page.getByRole('button', { name: 'Mark out for delivery', exact: true }).waitFor();
      assert.equal(await invoice.count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Record payment', exact: true }).count(), 0);
    });
  }
  await t.test('a failed invoice stays editable without advancing the order and success refreshes its active queue', async t => {
    const { page, state } = await fixture(t, { admin: true });
    state.task.packedAt = '2026-11-13T08:00:00.000Z'; state.task.items[0].allocations[0].pickedQty = 10;
    await page.goto(`${origin}/admin/orders?work=noInvoice`);
    await page.getByRole('button', { name: 'Create invoice', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create invoice', exact: true });
    state.invoiceError = 'Packing changed. Review the latest order before invoicing.';
    await dialog.getByRole('button', { name: 'Create invoice', exact: true }).click();
    await dialog.getByText(state.invoiceError, { exact: true }).waitFor();
    assert.equal(state.invoice, undefined);
    assert.equal(state.task.status, 'Shipping');
    assert.equal(await page.getByRole('button', { name: 'Mark out for delivery', exact: true }).count(), 0);
    state.invoiceError = '';
    await dialog.getByRole('button', { name: 'Create invoice', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByText('No orders found', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'To invoice 0', exact: true }).waitFor();
    assert.equal(state.writes.filter(write => write.action === 'create-invoice').length, 2);
  });
  await t.test('manual actions remain accessible and unfinished or cancelled tasks cannot invoice', async t => {
    const { page, state } = await fixture(t, { admin: true, published: false });
    state.task.status = 'Processing';
    await page.goto(`${origin}/admin/orders`);
    await page.getByRole('button', { name: 'Start preparation', exact: true }).waitFor();
    await openOrderTool(page, 'Create invoice');
    const dialog = page.getByRole('dialog', { name: 'Create invoice', exact: true });
    await dialog.waitFor(); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    state.task.status = 'Shipping';
    await page.reload(); await page.getByRole('button', { name: 'Send to worker', exact: true }).waitFor();
    await openOrderTool(page, 'Mark out for delivery');
    await page.getByRole('dialog', { name: 'Mark out for delivery', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
    state.task.sentAt = '2026-11-13T08:00:00.000Z';
    await page.reload(); await page.getByRole('link', { name: 'View packing', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Create invoice', exact: true }).count(), 0);
    await page.getByRole('button', { name: /^More actions for/ }).click();
    assert.equal(await page.getByRole('menuitem', { name: 'Create invoice', exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    state.task.status = 'Cancelled';
    await page.reload(); await page.getByText(state.task.orderNumber, { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Create invoice', exact: true }).count(), 0);
    assert.equal(state.writes.length, 0);
  });
  await t.test('order tools work by keyboard and touch without overflowing; filters and back navigation retain context', async t => {
    const { page, state } = await fixture(t, { admin: true });
    await page.goto(`${origin}/admin/orders?work=needsAdmin&paymentStatus=paymentDue&search=Ahmed&limit=20`);
    await page.getByText(state.task.orderNumber, { exact: true }).waitFor();
    const trigger = page.getByRole('button', { name: /^More actions for/ });
    await trigger.focus(); await page.keyboard.press('ArrowDown');
    await page.getByRole('menu').waitFor();
    await page.keyboard.press('End');
    assert.equal(await page.getByRole('menuitem', { name: 'Delete order', exact: true }).evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Escape'); assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
    await openOrderTool(page, 'Copy order summary');
    assert.match((await page.evaluate(() => window.__copies))[0], /Client: Ahmed Trading/);
    assert.equal(state.writes.length, 0);
    await page.getByText(state.task.orderNumber, { exact: true }).locator('..').getByRole('link').click();
    await page.getByRole('link', { name: 'View packing', exact: true }).click();
    assert.equal(new URL(page.url()).searchParams.get('work'), 'needsAdmin');
    await page.getByRole('link', { name: 'Back to order', exact: true }).click();
    await page.getByRole('button', { name: 'Back to orders', exact: true }).click();
    const restored = new URL(page.url()).searchParams;
    assert.equal(restored.get('work'), 'needsAdmin'); assert.equal(restored.get('paymentStatus'), 'paymentDue'); assert.equal(restored.get('limit'), '20');
    for (const width of [1024, 390, 320]) {
      await page.setViewportSize({ width, height: 850 });
      await trigger.click();
      const rect = await page.getByRole('menu').boundingBox();
      assert.ok(rect && rect.x >= 0 && rect.x + rect.width <= width && rect.y >= 0 && rect.y + rect.height <= 850);
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    const changed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/orders' && new URL(response.url()).searchParams.get('work') === 'preparation');
    await page.getByRole('button', { name: /Preparation 1/ }).click();
    await changed;
    await page.getByText(state.task.orderNumber, { exact: true }).waitFor();
    assert.equal(state.orderQueries.at(-1).work, 'preparation');
    assert.equal(state.orderQueries.at(-1).paymentStatus, 'paymentDue');
    assert.equal(state.orderQueries.at(-1).search, 'Ahmed');
  });
  await t.test('a removed last-page result returns to a valid page without losing filters', async t => {
    const { page, state } = await fixture(t, { admin: true }); state.emptyLastPage = true;
    await page.goto(`${origin}/admin/orders?work=needsAdmin&page=2&limit=10`);
    await page.getByText(state.task.orderNumber, { exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('page'), null);
    assert.equal(new URL(page.url()).searchParams.get('work'), 'needsAdmin');
    assert.equal(state.orderQueries[0].page, '2'); assert.equal(state.orderQueries.at(-1).page, '1');
  });
  await t.test('failed list requests never become empty queues and zero balances never become Paid', async t => {
    const { page, state } = await fixture(t, { admin: true });
    state.task.packedAt = '2026-11-13T08:00:00.000Z';
    state.invoice = { _id: '500000000000000000000001', invoiceNumber: 'ZERO', status: 'Issued', paymentStatus: 'Unpaid', amountMinor: 0, paidTotalMinor: 0, balanceDueMinor: 0 };
    await page.goto(`${origin}/admin/orders`);
    await page.getByText('No balance due', { exact: true }).waitFor();
    assert.equal(await page.getByRole('table').getByText('Paid', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Record payment', exact: true }).count(), 0);
    state.ordersFailed = true;
    await page.getByRole('button', { name: /^Worker help / }).click();
    await page.getByRole('button', { name: 'Retry orders', exact: true }).waitFor();
    assert.equal(await page.getByText('No orders found', { exact: true }).count(), 0);
    state.ordersFailed = false;
    await page.getByRole('button', { name: 'Retry orders', exact: true }).click();
    await page.getByText('No balance due', { exact: true }).waitFor();
  });
  await t.test('desktop rows and mobile cards keep distinct client, progress, billing and stock follow-up', async t => {
    const { page, state } = await fixture(t, { admin: true });
    const base = { _id: orderId, orderNumber: 'ORD-TEST-ONE', user: { name: 'Ahmed Trading with a long registered company name', email: 'hidden@test.invalid' }, createdAt: '2026-11-14T09:00:00Z', status: 'Shipping', allocationStatus: 'Allocated', orderItems: [{ product: 'p1', qty: 3, unitPrice: 10 }, { product: 'p1', qty: 7, unitPrice: 11 }], assignedTo: 'Ahmed', packingSentAt: '2026-11-14T09:00:00Z', packingSummary: { totalItems: 1, collectedItems: 0 }, stockChecksPending: 0, invoice: null };
    const packed = { ...base, packedAt: '2026-11-14T10:00:00Z' };
    const paid = { _id: 'invoice-1', invoiceNumber: 'INV-PAID', status: 'Issued', paymentStatus: 'Paid', amountMinor: 10700, paidTotalMinor: 10700, balanceDueMinor: 0 };
    const delivered = { ...packed, status: 'Delivered', invoice: paid };
    const finalized = { ...delivered, stockFinalizedAt: '2026-11-14T11:00:00Z' };
    state.listRows = [
      { ...base, helpRequestedItems: 1, stockChecksPending: 1, listAction: 'review-help' },
      { ...base, _id: '2', orderNumber: 'ORD-PACKING', user: { name: 'Al Noor Textiles' }, listAction: 'view-packing' },
      { ...base, _id: '3', orderNumber: 'ORD-PACKED', user: { name: 'Sara Packaging' }, packedAt: '2026-11-14T10:00:00Z', listAction: 'create-invoice' },
      { ...packed, _id: '4', orderNumber: 'ORD-DELIVERED', user: { name: 'Oasis Trading' }, status: 'Delivered', stockChecksPending: 2, listAction: 'create-invoice' },
      { ...packed, _id: '5', orderNumber: 'ORD-PAID-PACKED', invoice: paid, listAction: 'mark-out-for-delivery' },
      { ...finalized, _id: '6', orderNumber: 'ORD-PAYMENT-PENDING', invoice: { ...paid, paymentStatus: 'PartiallyPaid', paidTotalMinor: 5000, balanceDueMinor: 5700 }, listAction: null },
      { ...delivered, _id: '7', orderNumber: 'ORD-STOCK-PENDING', listAction: 'finalize-stock' },
      { ...finalized, _id: '8', orderNumber: 'ORD-COMPLETE', listAction: null },
      { ...finalized, _id: '9', orderNumber: 'ORD-REPORT-PENDING', stockChecksPending: 1, listAction: null },
      { ...finalized, _id: '10', orderNumber: 'ORD-BALANCE-UNKNOWN', invoice: { _id: 'invoice-2', invoiceNumber: 'INV-UNKNOWN', status: 'Issued' }, listAction: null },
      { ...finalized, _id: '11', orderNumber: 'ORD-UNPAID', invoice: { ...paid, paymentStatus: 'Unpaid', paidTotalMinor: 0, balanceDueMinor: 10700, dueDate: '2099-01-01T00:00:00Z' }, listAction: null },
      { ...finalized, _id: '12', orderNumber: 'ORD-OVERDUE', invoice: { ...paid, paymentStatus: 'Unpaid', paidTotalMinor: 0, balanceDueMinor: 10700, dueDate: '2020-01-01T00:00:00Z' }, listAction: null },
    ];
    state.orderPagination = { page: 1, totalPages: 1, total: 12, limit: 20 };
    state.summaryOverrides = { all: 12, needsAdmin: 1, preparation: 2, toInvoice: 2, toDeliver: 1, toFinalize: 1, needsStockCheck: 3 };
    await page.goto(`${origin}/admin/orders?limit=20`);
    await page.getByRole('table', { name: 'Admin orders', exact: true }).waitFor();
    assert.equal(await page.getByRole('columnheader').count(), 5);
    assert.equal(await page.getByRole('table').getByText('Not invoiced', { exact: true }).count(), 4);
    assert.equal(await page.getByText('hidden@test.invalid', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('table').getByText('1 item · 10 units', { exact: true }).count(), 12);
    assert.equal(await page.getByRole('link', { name: 'Review issue', exact: true }).count(), 1);
    await page.getByRole('link', { name: '2 reports need checking', exact: true }).waitFor();
    async function checkProgress(mobile) {
      const row = number => mobile ? page.getByRole('article', { name: 'Order ' + number, exact: true }) : page.getByRole('row').filter({ has: page.getByText(number, { exact: true }) });
      for (const number of ['ORD-PACKED', 'ORD-PAID-PACKED']) {
        await row(number).getByText('Awaiting delivery', { exact: true }).waitFor();
        await row(number).getByRole('group', { name: 'Preparation', exact: true }).getByText('Packed', { exact: true }).waitFor();
        assert.equal(await row(number).getByText('Complete', { exact: true }).count(), 0);
      }
      await row('ORD-PACKED').getByRole('button', { name: 'Create invoice', exact: true }).waitFor();
      await row('ORD-PAID-PACKED').getByRole('button', { name: 'Mark out for delivery', exact: true }).waitFor();
      await row('ORD-PAYMENT-PENDING').getByRole('group', { name: 'Billing', exact: true }).getByText('Partly paid', { exact: true }).waitFor();
      await row('ORD-PAYMENT-PENDING').getByRole('button', { name: 'Record payment', exact: true }).waitFor();
      await row('ORD-STOCK-PENDING').getByRole('group', { name: 'Stock', exact: true }).getByText('Pending', { exact: true }).waitFor();
      await row('ORD-STOCK-PENDING').getByRole('button', { name: 'Finalize stock', exact: true }).waitFor();
      await row('ORD-REPORT-PENDING').getByRole('link', { name: '1 report needs checking', exact: true }).waitFor();
      await row('ORD-BALANCE-UNKNOWN').getByText('Balance unavailable', { exact: true }).waitFor();
      await row('ORD-COMPLETE').getByRole('group', { name: 'Stock', exact: true }).getByText('Deducted', { exact: true }).waitFor();
      await row('ORD-COMPLETE').getByText('Delivered', { exact: true }).waitFor();
      assert.equal(await page.getByText('Complete', { exact: true }).count(), 0);
      for (const number of ['ORD-UNPAID', 'ORD-OVERDUE']) {
        const record = row(number);
        await record.getByRole('group', { name: 'Delivery', exact: true }).getByText('Delivered', { exact: true }).waitFor();
        await record.getByRole('group', { name: 'Stock', exact: true }).getByText('Deducted', { exact: true }).waitFor();
        await record.getByRole('group', { name: 'Billing', exact: true }).getByText(number === 'ORD-UNPAID' ? 'Unpaid' : 'Overdue', { exact: true }).waitFor();
        assert.equal(await record.getByRole('button', { name: 'Record payment', exact: true }).count(), 1);
        assert.equal(await record.getByRole('group', { name: 'Billing', exact: true }).getByRole('button', { name: 'Record payment', exact: true }).count(), 0);
        await record.getByRole('button', { name: /^More actions for / }).click();
        assert.equal(await page.getByRole('menuitem', { name: 'Record payment', exact: true }).count(), 0);
        await page.keyboard.press('Escape');
        assert.equal(await record.getByRole('group', { name: 'Billing', exact: true }).getByText(/^Total /).count(), 0);
      }
      assert.equal(await row('ORD-PAYMENT-PENDING').getByRole('group', { name: 'Billing', exact: true }).getByText(/^Total /).count(), 1);
      assert.equal(await page.getByText('No checks pending', { exact: true }).count(), 0);
      assert.equal(await page.getByText('Ready to deduct', { exact: true }).count(), 0);
    }
    await checkProgress(false);
    const paymentRow = page.getByRole('row').filter({ has: page.getByText('ORD-UNPAID', { exact: true }) });
    await paymentRow.getByRole('button', { name: 'Record payment', exact: true }).click();
    const paymentDialog = page.getByRole('dialog', { name: 'Add payment', exact: true });
    await paymentDialog.waitFor();
    assert.equal(Number(await paymentDialog.getByPlaceholder('0.00', { exact: true }).inputValue()), 107);
    assert.equal(state.writes.length, 0);
    await paymentDialog.getByRole('button', { name: 'Close', exact: true }).click();
    const moreLabel = page.getByRole('button', { name: /^More actions for / }).first().getByText('More', { exact: true });
    assert.ok((await moreLabel.boundingBox()).width > 20);
    assert.equal(await page.getByRole('navigation', { name: 'Pagination', exact: true }).count(), 2);
    await page.screenshot({ path: '/Users/azad/Developer/megadie/output/admin-orders-refreshed-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('article', { name: 'Order ORD-DELIVERED', exact: true }).waitFor();
    assert.equal(await page.getByRole('table').count(), 0);
    await checkProgress(true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: '/Users/azad/Developer/megadie/output/admin-orders-refreshed-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 320, height: 844 });
    await checkProgress(true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  });
  function stockReportFixture(state) {
    state.task.reports = [{ _id: 'report-1', sku: 'RIB-RED-25MM', slotLabel: 'A1-AE1', slot: '400000000000000000000001', pickedQty: 6, requestedQty: 10, shortQty: 4, byName: 'Worker Ahmed', at: '2026-11-13T07:00:00.000Z' }];
    state.task.reportsVersion = 1;
  }
  await t.test('admins check and reopen stock reports without changing picking progress', async t => {
    const { page, state, context } = await fixture(t, { admin: true, mobile: true }); stockReportFixture(state);
    await page.goto(`${origin}/admin/orders/${orderId}/packing#stock-reports`);
    await page.waitForFunction(() => { const rect = document.querySelector('#stock-reports')?.getBoundingClientRect(); return rect && rect.top >= 0 && rect.top < innerHeight; });
    await page.getByRole('button', { name: 'Mark checked', exact: true }).click();
    await page.getByText(/^Checked by Owner/).waitFor(); assert.equal(state.task.version, 0); assert.equal(state.task.items[0].pickedQty, 0);
    await page.reload(); await page.getByText('Stock reports (1)', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Reopen check', exact: true }).click();
    await page.getByText('Stock check needed', { exact: true }).waitFor();
    assert.equal(state.task.version, 0); assert.equal(state.task.stockChecksPending, 1);
    await context.setOffline(true);
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Mark checked' && button.disabled));
    assert.equal(state.writes.filter(write => write.action === 'review-stock').length, 2);
    await context.setOffline(false);
  });
  await t.test('a lost stock-review response requires loading saved state before another review', async t => {
    const { page, state } = await fixture(t, { admin: true }); stockReportFixture(state);
    await page.goto(`${origin}/admin/orders/${orderId}/packing`); state.loseReportResponse = true;
    await page.getByRole('button', { name: 'Mark checked', exact: true }).click();
    await page.getByRole('button', { name: 'Load latest reports', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Mark checked', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Load latest reports', exact: true }).click();
    await page.getByRole('button', { name: 'Reopen check', exact: true }).waitFor();
    assert.equal(state.writes.filter(write => write.action === 'review-stock').length, 1);
  });
  await t.test('an older packing read cannot overwrite a confirmed stock review', async t => {
    const { page, state } = await fixture(t, { admin: true }); stockReportFixture(state);
    await page.goto(`${origin}/admin/orders/${orderId}/packing`); await page.getByRole('button', { name: 'Mark checked', exact: true }).waitFor();
    state.holdRead = true; await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    while (!state.finishRead) await new Promise(resolve => setTimeout(resolve, 10));
    await page.getByRole('button', { name: 'Mark checked', exact: true }).click(); await page.getByText(/^Checked by Owner/).waitFor();
    state.finishRead(); await page.getByRole('button', { name: 'Refresh', exact: true }).waitFor();
    await page.getByText(/^Checked by Owner/).waitFor(); assert.equal(await page.getByRole('button', { name: 'Mark checked', exact: true }).count(), 0);
  });
  await t.test("worker access can be enabled through the existing user editor", async t => {
    const { page, state } = await fixture(t, { admin: true });
    await page.goto(`${origin}/admin/users/${workerId}/edit`);
    const access = page.getByLabel(/^Worker access/);
    await access.waitFor(); assert.equal(await access.isChecked(), false);
    await access.check();
    await page.getByRole("button", { name: "Update Info", exact: true }).click();
    await page.getByText("User info updated.", { exact: true }).waitFor();
    assert.equal(state.writes[0].body.isWorker, true);
    assert.equal(state.writes[0].body.isAdmin, false);
  });
  await t.test("workers receive the inactivity warning and can renew the same staff session", async t => {
    const { page, state } = await fixture(t);
    const start = Date.now();
    state.session = { sessionId: "fixture-staff-session", sessionExpiresAt: start + 1800000, sessionAbsoluteExpiresAt: start + 28800000, sessionServerTime: start };
    await page.clock.install({ time: new Date(start) });
    await page.goto(`${origin}/packing`);
    await page.getByRole("heading", { name: "My work", exact: true }).waitFor();
    state.session.sessionServerTime += 29 * 60000;
    await page.clock.fastForward(29 * 60000);
    const warning = page.getByRole("region", { name: "Work session warning", exact: true });
    await warning.waitFor();
    await warning.getByRole("button", { name: "Stay signed in", exact: true }).click();
    await warning.waitFor({ state: "hidden" });
    assert.equal(state.session.sessionExpiresAt, state.session.sessionServerTime + 1800000);
  });
  await t.test("two immediate confirmations submit only one write", async t => {
    const { page, state } = await fixture(t);
    state.delay = 200;
    await page.goto(`${origin}/packing/orders/${orderId}`);
    await page.getByRole("button", { name: /^Picked (all|remaining) /, exact: true }).evaluate(node => { node.click(); node.click(); });
    await page.getByRole("button", { name: "Saving…", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Mark packed", exact: true }).isDisabled(), true);
    await page.getByText("Picked 10 of 10", { exact: true }).waitFor();
    assert.equal(state.writes.length, 1);
  });
  await t.test("a delayed older read cannot overwrite a confirmed picked quantity", async t => {
    const { page, state } = await fixture(t);
    await page.goto(`${origin}/packing/orders/${orderId}`);
    await page.getByRole("button", { name: /^Picked (all|remaining) /, exact: true }).waitFor();
    state.holdRead = true;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    const until = Date.now() + 3000;
    while (!state.finishRead && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(state.finishRead);
    await page.getByRole("button", { name: /^Picked (all|remaining) /, exact: true }).click();
    await page.getByText("Picked 10 of 10", { exact: true }).waitFor();
    const oldResponse = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === `/api/packing/orders/${orderId}`);
    state.finishRead();
    await (await oldResponse).finished();
    await page.waitForTimeout(50);
    await page.waitForFunction(() => ![...document.querySelectorAll("button")].find(button => button.textContent === "Refresh")?.disabled);
    assert.equal(await page.getByText("Picked 10 of 10", { exact: true }).isVisible(), true);
    assert.equal(await page.getByRole("button", { name: /^Picked (all|remaining) /, exact: true }).count(), 0);
    assert.equal(state.writes.length, 1);
  });
  await t.test("empty work queues stay visible and errors do not pretend there is no work", async t => {
    const { page, state } = await fixture(t, { published: false, mobile: true });
    state.holdList = true;
    await page.goto(`${origin}/packing`);
    await page.getByText("Loading orders…", { exact: true }).first().waitFor();
    assert.equal(await page.getByText("No orders waiting to pack.", { exact: true }).count(), 0);
    state.holdList = false; state.finishList();
    for (const name of ["To pack", "Packed for delivery", "Ready for handoff"]) await page.getByRole("heading", { name: new RegExp(name) }).waitFor();
    await page.getByText("No orders waiting to pack.", { exact: true }).waitFor();
    await page.getByText("No packed delivery orders waiting.", { exact: true }).waitFor();
    await page.getByText("No packed orders waiting for handoff.", { exact: true }).waitFor();
    await page.screenshot({ path: "/Users/azad/Developer/megadie/output/worker-packing-refined-empty.png", fullPage: true });
    state.listFailed = true;
    await page.reload();
    await page.getByText("Could not load your packing orders.", { exact: true }).waitFor();
    assert.equal(await page.getByText("No orders waiting to pack.", { exact: true }).count(), 0);
  });
  await t.test("order cards show partial work and independently paginate the work queues", async t => {
    const { page, state } = await fixture(t);
    const base = { ...state.task, summary: { totalUnits: 100, pickedUnits: 35, remainingUnits: 65, totalItems: 3, collectedItems: 1, inProgressItems: 1, needsHelp: true } };
    state.boardRows = Array.from({ length: 16 }, (_, i) => ({ ...base, orderId: String(i), orderNumber: 'ORD-TEST-' + i, customerName: ['Ahmed Trading', 'Al Noor Textiles', 'Royal Gift Supplies'][i % 3] + ' ' + i, packedAt: i >= 13 ? '2026-11-11T08:30:00Z' : null, preparationMode: i === 13 ? 'prepare_deliver' : 'prepare_only', ...(i >= 13 ? { summary: { totalUnits: 100, pickedUnits: 100, remainingUnits: 0, totalItems: 3, collectedItems: 3, inProgressItems: 0, needsHelp: false } } : {}) }));
    await page.goto(`${origin}/packing`);
    await page.getByRole("link", { name: /^Continue packing for Ahmed Trading 0,/ }).waitFor();
    assert.equal(await page.getByText("35 / 100 units picked", { exact: true }).count(), 12);
    const queue = page.getByRole("region", { name: "To pack 13", exact: true });
    await queue.getByRole("button", { name: "Next", exact: true }).click();
    await queue.getByRole("link", { name: /^Continue packing for Ahmed Trading 12,/ }).waitFor();
    assert.equal(await queue.getByRole("link").count(), 1);
    assert.equal(await page.getByRole("link", { name: /^View delivery for/ }).count(), 0);
    assert.equal(await page.getByRole("link", { name: /^View packed order for/ }).count(), 3);
    await queue.getByRole("button", { name: "Previous", exact: true }).click();
    await queue.getByRole("link", { name: /^Continue packing for Ahmed Trading 0,/ }).waitFor();
    state.boardRows = [...state.boardRows.slice(0, 3), ...state.boardRows.slice(13)];
    await page.getByRole("button", { name: "Refresh orders", exact: true }).click();
    await page.getByRole("heading", { name: "To pack 3", exact: true }).waitFor();
    await page.screenshot({ path: "/Users/azad/Developer/megadie/output/worker-packing-refined-home-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  });
  await t.test("packed delivery work stays visible and opens its next step and map", async t => {
    const { page, state } = await fixture(t, { mobile: true });
    state.task.preparationMode = "prepare_deliver";
    state.task.packedAt = "2026-11-11T08:30:00.000Z"; state.task.packedBy = "Worker Ahmed";
    state.task.items[0].allocations[0].pickedQty = 10;
    state.task.delivery = { contactName: 'Delivery recipient', phoneNumber: '+971 (50) 123-4567', secondaryPhoneNumber: '04 123 4567', address: "Warehouse road", googleMapsUrl: "https://maps.google.com/?q=Dubai", notes: "Call at arrival" };
    await page.goto(`${origin}/packing`);
    await page.getByRole("button", { name: /^Deliveries/ }).click();
    await page.getByRole("link", { name: "View delivery", exact: true }).click();
    await page.getByText("Ready to deliver", { exact: true }).waitFor();
    assert.equal(await page.getByRole("link", { name: "Get directions", exact: true }).isVisible(), true);
    assert.equal(await page.getByRole("button", { name: "Mark packed", exact: true }).count(), 0);
    await page.getByText("Call at arrival", { exact: true }).waitFor();
    assert.equal(await page.getByText('Delivery recipient', { exact: true }).isVisible(), true);
    assert.equal(await page.getByRole('link', { name: 'Call recipient', exact: true }).getAttribute('href'), 'tel:+971501234567');
    assert.equal(await page.getByRole('link', { name: 'Call backup', exact: true }).getAttribute('href'), 'tel:041234567');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: '/Users/azad/Developer/megadie/output/worker-delivery-contact-mobile.png', fullPage: true });
  });
  await t.test('delivery contact handles absent and unsupported numbers without unsafe call links', async t => {
    const { page, state } = await fixture(t, { mobile: true });
    state.task.preparationMode = 'prepare_deliver'; state.task.packedAt = '2026-11-11T08:30:00.000Z';
    state.task.delivery = { contactName: 'Recipient without phone', address: 'Warehouse road' };
    await page.goto(`${origin}/packing/deliveries/${orderId}`);
    await page.getByText('No phone saved. Contact an admin if needed.', { exact: true }).waitFor();
    assert.equal(await page.locator('a[href^="tel:"]').count(), 0);
    state.task.delivery.phoneNumber = 'javascript:alert(1)'; state.task.delivery.secondaryPhoneNumber = '04 123 4567 ext 9';
    await page.reload();
    await page.getByText('javascript:alert(1)', { exact: true }).waitFor();
    await page.getByText('04 123 4567 ext 9', { exact: true }).waitFor();
    assert.equal(await page.locator('a[href^="tel:"]').count(), 0);
    state.task.delivery.phoneNumber = ''; state.task.delivery.secondaryPhoneNumber = '+971 50 123 4567';
    await page.reload();
    await page.getByRole('link', { name: 'Call recipient', exact: true }).waitFor();
    state.task.preparationMode = 'prepare_only'; state.task.delivery = null;
    await page.reload();
    await page.getByText('Recipient details are shown to the assigned delivery worker.').waitFor();
    assert.equal(await page.getByText('Delivery contact', { exact: true }).count(), 0);
    assert.equal(await page.locator('a[href^="tel:"]').count(), 0);
  });
  await t.test("admin order details are compact and packing monitoring requires explicit editing", async t => {
    const { page, state } = await fixture(t, { admin: true });
    await page.goto(`${origin}/admin/orders/${orderId}`);
    const summary = page.getByRole("region", { name: "Packing summary", exact: true });
    await summary.getByRole("link", { name: "View packing", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: /^Picked (all|remaining) /, exact: true }).count(), 0);
    assert.equal(await summary.getByRole("article").count(), 0);
    await page.screenshot({ path: "/Users/azad/Developer/megadie/output/worker-packing-refined-admin-order.png", fullPage: true });
    await summary.getByRole("link", { name: "View packing", exact: true }).click();
    await page.getByText("Monitor progress and resolve reported shortages.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: /^Picked (all|remaining) /, exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Mark packed", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Edit picking progress", exact: true }).click();
    await page.getByRole("button", { name: /^Picked (all|remaining) /, exact: true }).click();
    await page.getByText("Picked 10 of 10", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Done editing", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Mark packed", exact: true }).count(), 0);
    assert.deepEqual(state.writes.map(write => write.action), ["pick"]);
    await page.screenshot({ path: "/Users/azad/Developer/megadie/output/worker-packing-refined-admin-progress.png", fullPage: true });
  });
  await t.test("a sent assignment opens a summary and only changed assignments can be saved", async t => {
    const { page, state } = await fixture(t, { admin: true });
    state.task.preparationMode = 'prepare_deliver';
    Object.assign(state.task.deliveryDetails, { contactName: 'Existing recipient', phoneNumber: '+971 50 123 4567', secondaryPhoneNumber: '04 123 4567' });
    await page.goto(`${origin}/admin/orders/${orderId}/packing`);
    await page.getByRole("button", { name: "Packing worker", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Packing worker", exact: true });
    await dialog.getByRole("link", { name: "View packing", exact: true }).waitFor();
    assert.equal(await dialog.getByRole("combobox").count(), 0);
    await dialog.getByRole("button", { name: "Change assignment", exact: true }).click();
    assert.equal(await dialog.getByRole("button", { name: "Save changes", exact: true }).isDisabled(), true);
    assert.equal(await dialog.getByRole("radio").count(), 0);
    assert.equal(await dialog.getByLabel('Recipient name', { exact: true }).inputValue(), 'Existing recipient');
    assert.equal(await dialog.getByLabel('Phone number', { exact: true }).inputValue(), '+971 50 123 4567');
    await dialog.getByLabel('Recipient name', { exact: true }).fill('New recipient');

    assert.equal(await dialog.getByLabel('Recipient name', { exact: true }).inputValue(), 'New recipient');
    assert.equal(await dialog.getByRole("button", { name: "Save changes", exact: true }).isDisabled(), false);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await dialog.getByText("Discard unsaved changes?", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Keep editing", exact: true }).click();
    assert.equal(await dialog.getByRole("radio").count(), 0);
    await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await dialog.getByText("Assignment updated.", { exact: true }).waitFor();
    assert.equal(await dialog.getByRole("combobox").count(), 0);
    assert.equal(state.writes.at(-1).body.preparationMode, "prepare_deliver");
    assert.deepEqual(state.writes.at(-1).body.deliveryDetails, { contactName: 'New recipient', phoneNumber: '+971 50 123 4567', secondaryPhoneNumber: '04 123 4567', address: 'Warehouse road', googleMapsUrl: '', notes: '' });
    await dialog.getByRole('button', { name: 'Change assignment', exact: true }).click();
    assert.equal(await dialog.getByLabel('Recipient name', { exact: true }).inputValue(), 'New recipient');
    assert.equal(await dialog.getByRole('button', { name: 'Save changes', exact: true }).isDisabled(), true);
  });
  await t.test("one quantity editor supports increases and requires acknowledgement only for decreases", async t => {
    const { page, state } = await fixture(t);
    state.task.items[0].allocations[0].pickedQty = 4;
    await page.goto(`${origin}/packing/orders/${orderId}`);
    await page.getByRole("button", { name: "Correct count", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Correct count", exact: true });
    await dialog.getByLabel(/^How many have you picked from/).fill("6");
    assert.equal(await dialog.getByRole("checkbox").count(), 0);
    await dialog.getByRole("button", { name: "Save picked total", exact: true }).click();
    await page.getByText("Picked 6 of 10", { exact: true }).waitFor();
    assert.equal(state.writes[0].action, "pick");
    await page.getByRole('button', { name: 'Picked remaining 4', exact: true }).waitFor();
    await page.getByRole("button", { name: "Correct count", exact: true }).click();
    await dialog.getByLabel(/^How many have you picked from/).fill("2");
    await dialog.getByRole("checkbox").waitFor();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await dialog.getByRole("button", { name: "Keep editing", exact: true }).click();
    assert.equal(await dialog.getByLabel(/^How many have you picked from/).inputValue(), "2");
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "Save picked total", exact: true }).click();
    await page.getByText("Picked 2 of 10", { exact: true }).waitFor();
    assert.equal(state.writes[1].action, "correct");
    assert.equal(state.writes[1].body.confirmedReturn, true);
  });
  await t.test("a session warning remains inside an open packing dialog", async t => {
    const { page, state } = await fixture(t);
    const start = Date.now();
    state.session = { sessionId: "fixture-staff-session", sessionExpiresAt: start + 1800000, sessionAbsoluteExpiresAt: start + 28800000, sessionServerTime: start };
    await page.clock.install({ time: new Date(start) });
    await page.goto(`${origin}/packing/orders/${orderId}`);
    await page.getByRole("button", { name: "Not enough here", exact: true }).click();
    // The click renews activity. Let the client apply that response before
    // advancing its clock, otherwise a late response starts a new fake deadline.
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('megadie.admin-session.v2') || '{}').type === 'renewed');
    state.session.sessionServerTime += 29 * 60000;
    await page.clock.fastForward(29 * 60000);
    const dialog = page.getByRole("dialog", { name: "Not enough here", exact: true });
    const warning = dialog.getByRole("region", { name: "Work session warning", exact: true });
    await warning.waitFor();
    await warning.getByRole("button", { name: "Stay signed in", exact: true }).click();
    await warning.waitFor({ state: "hidden" });
    assert.equal(await dialog.isVisible(), true);
  });

  await t.test("reservation navigation cannot discard an edited assignment silently", async t => {
    const { page, state } = await fixture(t, { admin: true, published: false });
    state.task.items[0].allocations[0].qty = 6;
    await page.goto(`${origin}/admin/orders/${orderId}`);
    await page.getByRole("button", { name: "Send to worker", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Send to worker", exact: true });
    await dialog.getByRole("radio", { name: "Pack & deliver", exact: true }).check();
    await dialog.getByRole("link", { name: "Review reservations", exact: true }).click();
    await dialog.getByText("Discard unsaved changes?", { exact: true }).waitFor();
    assert.equal(new URL(page.url()).search, "");
    await dialog.getByRole("button", { name: "Keep editing", exact: true }).click();
    assert.equal(await dialog.getByRole("radio", { name: "Pack & deliver", exact: true }).isChecked(), true);
    assert.equal(state.writes.length, 0);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await dialog.getByRole("button", { name: "Discard changes", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
  });
  await t.test("losing the connection disables picking without waiting for a save to fail", async t => {
    const { page, state, context } = await fixture(t);
    await page.goto(`${origin}/packing/orders/${orderId}`);
    await page.getByRole("button", { name: /^Picked (all|remaining) /, exact: true }).waitFor();
    await context.setOffline(true);
    await page.getByText("You are offline. Saved progress is shown; reconnect to continue.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: /^Picked (all|remaining) /, exact: true }).isDisabled(), true);
    assert.equal(state.writes.length, 0);
    await context.setOffline(false);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByRole("button", { name: /^Picked (all|remaining) /, exact: true }).click();
    await page.getByText("Picked 10 of 10", { exact: true }).waitFor();
    assert.equal(state.writes.length, 1);
  });

  await t.test("picked reserved orders keep a visible delete action and require both confirmations on mobile", async t => {
    const { page, state } = await fixture(t, { admin: true, mobile: true });
    state.task.items[0].allocations[0].pickedQty = 6;
    await page.goto(`${origin}/admin/orders`);
    await openOrderTool(page, 'Delete order');
    const dialog = page.getByRole("dialog", { name: "Delete Order", exact: true });
    const submit = dialog.getByRole("button", { name: "Delete Order", exact: true });
    await dialog.getByText("Picked goods to return", { exact: true }).waitFor();
    const bounds = await submit.boundingBox();
    assert.ok(bounds && bounds.y + bounds.height <= 850, "Delete action stays inside the mobile viewport");
    assert.equal(await submit.isDisabled(), true);
    await dialog.getByLabel("The worker has stopped picking, and all collected goods are physically in their original slots.", { exact: true }).check();
    assert.equal(await submit.isVisible(), true);
    assert.equal(await submit.isDisabled(), true);
    await dialog.getByLabel(/^Type ORD-TEST-9E7D51 to confirm/).fill(state.task.orderNumber);
    assert.equal(await submit.isDisabled(), false);
    await page.screenshot({ path: "/Users/azad/Developer/megadie/output/order-delete-return-mobile.png", fullPage: true });
    await submit.evaluate(node => { node.click(); node.click(); });
    await dialog.waitFor({ state: "hidden" });
    assert.equal(state.writes.length, 1);
    assert.equal(state.writes[0].body.confirmedPhysicalReturn, true);
    assert.equal(state.writes[0].body.expectedRevision, 0);
  });
  await t.test("a changed order forces a refreshed preview and a new return confirmation", async t => {
    const { page, state } = await fixture(t, { admin: true });
    state.task.items[0].allocations[0].pickedQty = 4;
    await page.goto(`${origin}/admin/orders`);
    await openOrderTool(page, 'Delete order');
    const dialog = page.getByRole("dialog", { name: "Delete Order", exact: true });
    const checkbox = dialog.getByRole("checkbox");
    await checkbox.check();
    await dialog.getByLabel(/^Type ORD-TEST-9E7D51 to confirm/).fill(state.task.orderNumber);
    state.task.version++; state.task.items[0].allocations[0].pickedQty = 6;
    await dialog.getByRole("button", { name: "Delete Order", exact: true }).click();
    await dialog.getByRole("button", { name: "Refresh delete preview", exact: true }).waitFor();
    assert.equal(await dialog.getByRole("button", { name: "Delete Order", exact: true }).isDisabled(), true);
    assert.equal(await checkbox.isChecked(), false);
    await dialog.getByRole("button", { name: "Refresh delete preview", exact: true }).click();
    await dialog.getByText("6 × 100yd Roll", { exact: true }).waitFor();
    await checkbox.check();
    await dialog.getByLabel(/^Type ORD-TEST-9E7D51 to confirm/).fill(state.task.orderNumber);
    await dialog.getByRole("button", { name: "Delete Order", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(state.writes.map(row => row.body.expectedRevision), [0, 1]);
    assert.equal(state.previewReads, 2);
  });
  await t.test("genuine deletion blockers show a disabled action with no misleading return checkbox", async t => {
    const { page, state } = await fixture(t, { admin: true });
    state.deleteBlockers = ["Stock was finalized, but deducted allocation records are missing."];
    await page.goto(`${origin}/admin/orders`);
    await openOrderTool(page, 'Delete order');
    const dialog = page.getByRole("dialog", { name: "Delete Order", exact: true });
    await dialog.getByText(state.deleteBlockers[0], { exact: false }).waitFor();
    assert.equal(await dialog.getByRole("button", { name: "Delete Order", exact: true }).isVisible(), true);
    assert.equal(await dialog.getByRole("button", { name: "Delete Order", exact: true }).isDisabled(), true);
    assert.equal(await dialog.getByRole("checkbox").count(), 0);
    assert.equal(state.writes.length, 0);
  });
  await t.test("a lost delete response cannot be submitted again before checking saved state", async t => {
    const { page, state } = await fixture(t, { admin: true });
    state.loseDeleteResponse = true;
    await page.goto(`${origin}/admin/orders`);
    await openOrderTool(page, 'Delete order');
    const dialog = page.getByRole("dialog", { name: "Delete Order", exact: true });
    await dialog.getByRole("checkbox").check();
    await dialog.getByLabel(/^Type ORD-TEST-9E7D51 to confirm/).fill(state.task.orderNumber);
    await dialog.getByRole("button", { name: "Delete Order", exact: true }).click();
    await dialog.getByRole("button", { name: "Refresh delete preview", exact: true }).waitFor();
    assert.equal(await dialog.getByRole("button", { name: "Delete Order", exact: true }).isDisabled(), true);
    await dialog.getByRole("button", { name: "Refresh delete preview", exact: true }).click();
    await dialog.getByText("Order not found.", { exact: true }).waitFor();
    assert.equal(state.writes.length, 1);
    assert.equal(state.deleted, true);
  });

  await t.test('a shortage continues to another slot in one action and counts additional picks exactly once', async t => {
    const { page, state } = await fixture(t, { mobile: true });
    state.task.items[0].allocations[0].pickedQty = 3;
    await page.goto(`${origin}/packing/orders/${orderId}`);
    await page.getByRole('button', { name: 'Not enough here', exact: true }).click();
    await page.getByLabel('How many did you take this time?', { exact: true }).fill('2');
    const next = page.getByRole('button', { name: 'Continue at B2-AE1 \u2014 5 \u00d7 100yd Roll', exact: true });
    assert.equal(await page.getByRole('button', { name: 'Save shortage', exact: true }).count(), 0);
    await next.evaluate(button => { button.click(); button.click(); });
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(state.writes.map(write => write.action), ['problem', 'replace']);
    assert.equal(state.writes[0].body.pickedQty, 5);
    assert.equal(state.task.items[0].pickedQty, 5);
    await page.getByText('5 / 10 units picked', { exact: true }).waitFor();
    assert.equal(state.task.items[0].allocations.find(row => row.slot === 'B2-AE1').pickedQty, 0);
  });
  await t.test('an unavailable replacement preserves the saved count and retries only the remaining work', async t => {
    const { page, state } = await fixture(t);
    state.replaceConflict = true;
    await page.goto(`${origin}/packing/orders/${orderId}`);
    await page.getByRole('button', { name: 'Not enough here', exact: true }).click();
    await page.getByLabel('How many did you take this time?', { exact: true }).fill('6');
    await page.getByRole('button', { name: /^Continue at B2-AE1/ }).click();
    await page.getByRole('button', { name: 'Check latest progress', exact: true }).click();
    await page.getByRole('dialog').getByText('No available replacement.', { exact: true }).waitFor();
    assert.equal(state.task.items[0].pickedQty, 6); assert.equal(state.task.reports.length, 1);
    await page.getByRole('dialog').getByRole('button', { name: 'Ask admin for help', exact: true }).click();
    await page.getByRole('dialog').getByText('Admin help requested.', { exact: true }).waitFor();
    assert.deepEqual(state.writes.map(write => write.action), ['problem', 'replace', 'help']);
  });
  await t.test('a lost partial-count response recovers the count before replacing without adding it twice', async t => {
    const { page, state } = await fixture(t);
    state.loseResponse = true;
    await page.goto(`${origin}/packing/orders/${orderId}`);
    await page.getByRole('button', { name: 'Not enough here', exact: true }).click();
    await page.getByLabel('How many did you take this time?', { exact: true }).fill('6');
    await page.getByRole('button', { name: /^Continue at B2-AE1/ }).click();
    await page.getByRole('button', { name: 'Check latest progress', exact: true }).click();
    await page.getByRole('dialog').getByText('6 picked \u00b7 4 needed from another location', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Update picked total', exact: true }).waitFor();
    assert.equal(await page.getByLabel('How many did you take this time?', { exact: true }).count(), 0);
    await page.getByRole('button', { name: /^Continue at B2-AE1/ }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(state.writes.map(write => write.action), ['problem', 'replace']);
    assert.equal(state.task.items[0].pickedQty, 6);
  });
  await t.test('partial replacements leave the remainder visible and the destination unpicked', async t => {
    const { page, state } = await fixture(t);
    state.task.items[0].alternatives[0].availableQty = 2;
    await page.goto(`${origin}/packing/orders/${orderId}`);
    await page.getByRole('button', { name: 'Not enough here', exact: true }).click();
    await page.getByLabel('How many did you take this time?', { exact: true }).fill('4');
    await page.getByText('Take 2 here \u00b7 4 still needed elsewhere', { exact: true }).waitFor();
    await page.getByRole('button', { name: /^Continue at B2-AE1/ }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByRole('group', { name: 'Location B2-AE1 for RIB-RED-25MM', exact: true }).getByRole('button', { name: 'Picked all 2', exact: true }).click();
    await page.getByText('6 / 10 units picked', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Mark packed', exact: true }).isDisabled(), true);
    await page.getByRole('group', { name: 'Location A1-AE1 for RIB-RED-25MM', exact: true }).getByText('4 \u00d7 100yd Roll missing', { exact: true }).waitFor();
  });
  await t.test('a ready card marks packed once without opening the order and keeps completed picking blue until confirmation', async t => {
    const { page, state } = await fixture(t, { mobile: true });
    state.task.items[0].allocations[0].pickedQty = 10;
    await page.goto(`${origin}/packing`);
    await page.getByText('10 / 10 units picked', { exact: true }).waitFor();
    await page.getByText('Ready to pack', { exact: true }).waitFor();
    const card = page.getByRole('article').filter({ hasText: 'Ahmed Trading' });
    assert.match(await card.getByRole('progressbar').locator('div').getAttribute('class'), /bg-blue-500/);
    await card.getByRole('button', { name: 'Mark packed', exact: true }).evaluate(button => { button.click(); button.click(); });
    await page.getByRole('link', { name: /^View packed order for/ }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/packing');
    assert.equal(state.writes.filter(write => write.action === 'packed').length, 1);
    await page.screenshot({ path: '/Users/azad/Developer/megadie/output/worker-card-packed-mobile.png', fullPage: true });
  });
  await t.test('a stale card refreshes into incomplete picking and cannot finish the order', async t => {
    const { page, state } = await fixture(t);
    state.task.items[0].allocations[0].pickedQty = 10; state.packingConflict = true;
    await page.goto(`${origin}/packing`);
    await page.getByRole('button', { name: 'Mark packed', exact: true }).click();
    await page.getByRole('button', { name: 'Check latest progress', exact: true }).click();
    await page.getByText('9 / 10 units picked', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Mark packed', exact: true }).count(), 0);
    assert.equal(state.task.packedAt, null);
  });
  await t.test('a lost card completion response reads the saved Packed state without repeating completion', async t => {
    const { page, state } = await fixture(t);
    state.task.items[0].allocations[0].pickedQty = 10; state.loseResponse = true;
    await page.goto(`${origin}/packing`);
    await page.getByRole('button', { name: 'Mark packed', exact: true }).click();
    await page.getByRole('button', { name: 'Check latest progress', exact: true }).click();
    await page.getByRole('link', { name: /^View packed order for/ }).waitFor();
    assert.equal(state.writes.filter(write => write.action === 'packed').length, 1);
  });

});
