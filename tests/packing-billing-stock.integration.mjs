// Guarded disposable local DB; never imports server.js or sends notifications.
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import express from 'express';
import cookieParser from 'cookie-parser';
import User from '../models/userModel.js';
import Order from '../models/orderModel.js';
import Invoice from '../models/invoiceModel.js';
import Product from '../models/productModel.js';
import Slot from '../models/slotModel.js';
import SlotItem from '../models/slotItemModel.js';
import OrderAllocation from '../models/orderAllocationModel.js';
import InventoryMovement from '../models/inventoryMovementModel.js';
import orderRoutes from '../routes/orderRoutes.js';
import packingRoutes from '../routes/packingRoutes.js';
import invoiceRoutes from '../routes/invoiceRoutes.js';
import { errorHandler } from '../middleware/errorMiddleware.js';
import { testSessionCookies } from './helpers/sessionCookie.mjs';

const uri = process.env.PACKING_REVIEW_TEST_URI;
test('packing invoice timing and stock-report checks', { skip: !uri, timeout: 120000 }, async t => {
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\/megadie_packing_review_test(?:\?|$)/);
  process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'isolated-packing-review-test';
  await mongoose.connect(uri, { autoIndex: false }); await mongoose.connection.dropDatabase();
  t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  await OrderAllocation.createIndexes(); await Invoice.createIndexes(); await InventoryMovement.createCollection();
  const makeUser = (name, attrs = {}) => User.create({ name, email: name + '@test.invalid', phoneNumber: name, password: 'test-password', approvalStatus: 'Approved', ...attrs });
  const admin = await makeUser('Owner', { isAdmin: true }), worker = await makeUser('Worker', { isWorker: true }), customer = await makeUser('Client');
  const app = express(); app.use(express.json(), cookieParser()); app.use('/api/orders', orderRoutes); app.use('/api/packing', packingRoutes); app.use('/api/invoices', invoiceRoutes); app.use(errorHandler);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port + '/api', cookieFor = testSessionCookies();
  async function api(path, { actor = admin, method = 'GET', body, origin = 'http://localhost:5173' } = {}) {
    const response = await fetch(base + path, { method, headers: { Cookie: await cookieFor(actor), Origin: origin, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  const ok = (result, status = 200) => assert.equal(result.status, status, JSON.stringify(result.body));
  async function fixture({ published = true, packed = false } = {}) {
    await Order.deleteMany({}); await OrderAllocation.deleteMany({}); await Invoice.deleteMany({});
    const product = new mongoose.Types.ObjectId();
    await Product.collection.insertOne({ _id: product, name: 'Ribbon', sku: 'RIB-' + product, packingUnit: 'Roll', isActive: true, cbm: 1 });
    const slot = await Slot.create({ store: 'AE1', unit: 'A', position: 1, cbm: 1000 });
    await SlotItem.collection.insertOne({ product, slot: slot._id, qty: 37, cbm: 37 });
    const order = await Order.create({ user: customer._id, status: 'Shipping', orderItems: [{ product, sku: 'RIB-' + product, qty: 37, unitPrice: 2.5 }], deliveryCharge: 5, extraFee: 1, allocationStatus: 'Allocated', ...(published ? { packingWorker: worker._id, packingSentAt: new Date(), assignedTo: worker.name, preparationMode: 'prepare_only' } : {}), ...(packed ? { packedAt: new Date(), packedBy: worker._id } : {}) });
    const allocation = await OrderAllocation.create({ order: order._id, product, slot: slot._id, qty: 37, pickedQty: packed ? 37 : 0, by: admin._id });
    return { order, product, slot, allocation, path: '/packing/orders/' + order._id };
  }
  const view = async (f, actor = admin) => { const result = await api(f.path, { actor }); ok(result); return result.body.data; };
  const stored = f => Order.findById(f.order._id).select('+reservationRevision +packingReports +packingReportsRevision +packingActivity +packingHelp');
  async function action(f, name, data = {}, actor = worker) { return api(f.path + '/' + name, { actor, method: 'POST', body: { allocationId: String(f.allocation._id), expectedRevision: (await view(f)).version, ...data } }); }
  async function send(f) { const data = await view(f); return api(f.path + '/send', { method: 'POST', body: { expectedRevision: data.version, expectedDeliveryRevision: data.deliveryRevision, workerId: String(worker._id), preparationMode: 'prepare_only', deliveryDetails: {} } }); }
  const invoice = f => api('/invoices/from-order/' + f.order._id, { method: 'POST', body: { dueDate: '2030-01-01' } });
  const check = (f, reportId, data) => api(f.path + '/reports/' + reportId, { method: 'PATCH', body: data });

  await t.test('invoicing works before, during, and after packing without changing physical progress', async () => {
    for (const phase of ['unassigned', 'assigned', 'partial', 'picked', 'packed']) {
      const f = await fixture({ published: phase !== 'unassigned', packed: phase === 'packed' });
      if (phase === 'partial' || phase === 'picked') ok(await action(f, 'pick', { pickedQty: phase === 'partial' ? 7 : 37 }));
      const before = await stored(f), picked = (await OrderAllocation.findById(f.allocation._id)).pickedQty;
      const result = await invoice(f); ok(result, 201);
      assert.equal(result.body.data.amountMinor, 9850);
      const after = await stored(f);
      assert.equal(Boolean(after.packedAt), Boolean(before.packedAt), phase);
      assert.equal(after.status, before.status);
      assert.equal(after.stockFinalizedAt, undefined);
      assert.equal(after.deliveryMovement, undefined);
      assert.equal((await OrderAllocation.findById(f.allocation._id)).pickedQty, picked);
      assert.equal((await SlotItem.findOne({ product: f.product })).qty, 37);
      assert.equal((await invoice(f)).status, 400);
      assert.equal(await Invoice.countDocuments({ order: f.order._id }), 1);
    }
  });
  await t.test('an invoiced order can enter live packing while its billed items stay locked', async () => {
    const f = await fixture({ published: false }), billed = await invoice(f); ok(billed, 201);
    ok(await send(f));
    let sheet = await view(f), order = await stored(f);
    assert.ok(order.packingSentAt); assert.equal(String(order.invoice), billed.body.data._id);
    assert.equal(sheet.sendLockReason, ''); assert.equal(sheet.hasInvoice, true);
    assert.match(sheet.editItemsLockReason, /Invoice exists/);
    // A missing order reference cannot bypass the item lock or create a second invoice.
    await Order.updateOne({ _id: order._id }, { $unset: { invoice: '' } });
    ok(await send(f)); sheet = await view(f);
    assert.match(sheet.editItemsLockReason, /Invoice exists/);
    assert.equal((await invoice(f)).status, 400);
    assert.equal(await Invoice.countDocuments({ order: f.order._id }), 1);
  });
  await t.test('invoicing and assignment can both finish, with a fresh retry after any revision conflict', async () => {
    const f = await fixture({ published: false });
    const [billed, sent] = await Promise.all([invoice(f), send(f)]); ok(billed, 201);
    assert.ok([200, 409].includes(sent.status), JSON.stringify(sent));
    if (sent.status === 409) ok(await send(f));
    const order = await stored(f); assert.ok(order.invoice); assert.ok(order.packingSentAt);
    assert.equal(await Invoice.countDocuments({ order: order._id }), 1);
    assert.equal(await OrderAllocation.countDocuments({ order: order._id }), 1);
  });
  await t.test('an invoiced packed order can reopen in store, including concurrent invoicing', async () => {
    let f = await fixture({ packed: true }); ok(await invoice(f), 201);
    ok(await action(f, 'reopen', {}, admin));
    assert.equal((await stored(f)).packedAt, undefined);
    assert.equal((await view(f)).reopenLockReason, '');
    assert.equal((await OrderAllocation.findById(f.allocation._id)).pickedQty, 37);
    assert.equal((await Invoice.findOne({ order: f.order._id })).amountMinor, 9850);
    f = await fixture({ packed: true });
    const [billed, reopened] = await Promise.all([invoice(f), action(f, 'reopen', {}, admin)]); ok(billed, 201);
    assert.ok([200, 409].includes(reopened.status));
    if (reopened.status === 409) ok(await action(f, 'reopen', {}, admin));
    const order = await stored(f); assert.ok(order.invoice); assert.equal(order.packedAt, undefined);
  });
  await t.test('invoiced shortages allow source replacement but cannot change billed quantities or dispatch incomplete goods', async () => {
    const f = await fixture(); ok(await invoice(f), 201);
    ok(await action(f, 'problem', { pickedQty: 7 }));
    assert.equal((await action(f, 'packed')).status, 409);
    const sheet = await view(f);
    assert.equal((await api('/orders/' + f.order._id + '/items-preview', { method: 'POST', body: { expectedRevision: sheet.version, items: [{ key: 'line-0', qty: 7 }] } })).status, 409);
    assert.equal((await api('/orders/' + f.order._id, { method: 'PUT', body: { deliveryCharge: 0 } })).status, 400);
    assert.equal((await api('/orders/' + f.order._id + '/movement', { method: 'POST', body: { action: 'departed', method: 'company', handler: 'Azad', expectedRevision: sheet.version } })).status, 409);
    assert.equal((await api('/orders/' + f.order._id + '/allocations/finalize', { method: 'POST' })).status, 409);
    const target = await Slot.create({ store: 'AE1', unit: 'B', position: 2, cbm: 1000 });
    await SlotItem.collection.insertOne({ product: f.product, slot: target._id, qty: 30, cbm: 30 });
    ok(await action(f, 'replace', { slotId: String(target._id), qty: 30 }));
    const replacement = await OrderAllocation.findOne({ order: f.order._id, slot: target._id });
    ok(await action(f, 'pick', { allocationId: String(replacement._id), pickedQty: 30 }));
    ok(await action(f, 'packed'));
    assert.equal((await Invoice.findOne({ order: f.order._id })).amountMinor, 9850);
    assert.equal((await stored(f)).orderItems[0].qty, 37);
    assert.equal((await SlotItem.findOne({ product: f.product, slot: target._id })).qty, 30);
  });
  await t.test('removing an invoiced assignment keeps the invoice and requires the same physical return checks', async () => {
    const f = await fixture(), billed = await invoice(f); ok(billed, 201);
    ok(await action(f, 'pick', { pickedQty: 7 }));
    const remove = async () => { const sheet = await view(f); return api(f.path + '/unassign', { method: 'POST', body: { expectedRevision: sheet.version, expectedDeliveryRevision: sheet.deliveryRevision, confirmedPhysicalReturn: true } }); };
    assert.equal((await remove()).status, 409);
    ok(await action(f, 'correct', { pickedQty: 0, confirmedReturn: true }, admin));
    ok(await remove());
    const order = await stored(f); assert.equal(order.packingSentAt, undefined);
    assert.equal(String(order.invoice), billed.body.data._id);
    assert.equal((await Invoice.findById(order.invoice)).amountMinor, 9850);
    assert.equal((await OrderAllocation.findById(f.allocation._id)).qty, 37);
  });
  await t.test('duplicate invoice races and simultaneous item edits preserve a single matching bill', async () => {
    let f = await fixture();
    const invoices = await Promise.all([invoice(f), invoice(f)]);
    assert.deepEqual(invoices.map(r => r.status).sort(), [201, 400]);
    assert.equal(await Invoice.countDocuments({ order: f.order._id }), 1);
    f = await fixture(); const items = [{ key: 'line-0', qty: 7 }], sheet = await view(f);
    const preview = await api('/orders/' + f.order._id + '/items-preview', { method: 'POST', body: { expectedRevision: sheet.version, items } }); ok(preview);
    const [billed, edited] = await Promise.all([invoice(f), api('/orders/' + f.order._id + '/items', { method: 'PUT', body: { expectedRevision: sheet.version, token: preview.body.data.token, items } })]);
    ok(billed, 201); assert.ok([200, 409].includes(edited.status));
    const order = await stored(f), bill = await Invoice.findById(order.invoice);
    assert.equal(bill.amountMinor, Math.round(order.totalPrice * 100));
    assert.equal(order.orderItems[0].qty, edited.status === 200 ? 7 : 37);
  });
  await t.test('stock review changes no stock, picked counts, financial totals, worker revision or active help', async () => {
    const f = await fixture(); ok(await action(f, 'problem', { pickedQty: 7 }));
    const sheet = await view(f), before = await stored(f), report = sheet.reports[0];
    assert.equal(sheet.stockChecksPending, 1);
    const result = await check(f, report._id, { checked: true, expectedReportsVersion: sheet.reportsVersion, actor: customer._id }); ok(result);
    assert.equal(result.body.data.stockChecksPending, 0); assert.equal(result.body.data.version, sheet.version);
    const order = await stored(f); assert.equal(order.reservationRevision, before.reservationRevision); assert.equal(order.totalPrice, before.totalPrice);
    assert.equal(String(order.packingReports[0].checkedBy), String(admin._id)); assert.equal(order.packingReports[0].checkedByName, 'Owner');
    assert.equal((await OrderAllocation.findById(f.allocation._id)).pickedQty, 7); assert.equal((await SlotItem.findById((await SlotItem.findOne({ product: f.product }))._id)).qty, 37);
    assert.equal(result.body.data.helpRequestedItems, 1); assert.equal(await InventoryMovement.countDocuments({ order: order._id }), 0);
    const workerData = await view(f, worker); assert.doesNotMatch(JSON.stringify(workerData), /checkedBy|checkedAt|stockChecksPending|reportsVersion|unitPrice/);
    // An admin stock review does not invalidate the worker's current pick version.
    const picked = await api(f.path + '/problem', { actor: worker, method: 'POST', body: { allocationId: String(f.allocation._id), expectedRevision: sheet.version, pickedQty: 8 } }); ok(picked);
    const latest = await view(f); assert.equal(latest.stockChecksPending, 1); assert.equal(latest.reports.length, 2); assert.ok(latest.reports[0].checkedAt); assert.equal(latest.reports[1].checkedAt, undefined);
  });
  await t.test('stock checks remain discoverable on delivered/cancelled orders and old reports need no backfill', async () => {
    const f = await fixture(); ok(await action(f, 'problem', { pickedQty: 7 }));
    await Order.updateOne({ _id: f.order._id }, { $set: { status: 'Delivered' }, $unset: { packingReportsRevision: '' } });
    let list = await api('/orders?work=needsStockCheck'); ok(list); assert.equal(list.body.data.length, 1); assert.equal(list.body.data[0].stockChecksPending, 1);
    let summary = await api('/orders/work-summary'); ok(summary); assert.equal(summary.body.data.needsStockCheck, 1);
    const detail = await api('/orders/' + f.order._id); ok(detail); assert.equal(detail.body.data.stockChecksPending, 1); assert.equal(detail.body.data.packingReports, undefined);
    const clientDetail = await api('/orders/' + f.order._id, { actor: customer }); ok(clientDetail); assert.equal(clientDetail.body.data.stockChecksPending, undefined);
    let sheet = await view(f); assert.equal(sheet.reportsVersion, 0);
    ok(await check(f, sheet.reports[0]._id, { checked: true, expectedReportsVersion: 0 }));
    list = await api('/orders?work=needsStockCheck'); ok(list); assert.equal(list.body.data.length, 0);
    summary = await api('/orders/work-summary'); assert.equal(summary.body.data.needsStockCheck, 0);
    await Order.updateOne({ _id: f.order._id }, { $set: { status: 'Cancelled' }, $unset: { packingSentAt: '', packingWorker: '' } });
    sheet = await view(f); ok(await check(f, sheet.reports[0]._id, { checked: false, expectedReportsVersion: sheet.reportsVersion }));
    list = await api('/orders?work=needsStockCheck'); assert.equal(list.body.data[0].status, 'Cancelled'); assert.equal(list.body.data[0].stockChecksPending, 1);
  });
  await t.test('review access, trusted origin, report identity and stale review versions are enforced', async () => {
    const f = await fixture(); ok(await action(f, 'problem', { pickedQty: 7 })); const sheet = await view(f), reportId = sheet.reports[0]._id;
    for (const actor of [worker, customer]) assert.equal((await api(f.path + '/reports/' + reportId, { actor, method: 'PATCH', body: { checked: true, expectedReportsVersion: sheet.reportsVersion } })).status, 403);
    assert.equal((await api(f.path + '/reports/' + reportId, { origin: 'https://untrusted.invalid', method: 'PATCH', body: { checked: true, expectedReportsVersion: sheet.reportsVersion } })).status, 403);
    assert.equal((await check(f, reportId, { checked: true, expectedReportsVersion: '1' })).status, 400);
    assert.equal((await check(f, new mongoose.Types.ObjectId(), { checked: true, expectedReportsVersion: sheet.reportsVersion })).status, 404);
    assert.equal((await view(f)).reportsVersion, sheet.reportsVersion);
    const results = await Promise.all([1, 2].map(() => check(f, reportId, { checked: true, expectedReportsVersion: sheet.reportsVersion })));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    assert.equal((await check(f, reportId, { checked: false, expectedReportsVersion: sheet.reportsVersion })).status, 409);
    assert.equal((await stored(f)).packingActivity.filter(event => event.action === 'STOCK_REPORT_CHECKED').length, 1);
  });
  await t.test('a concurrent shortage update retains the original review and the new unchecked report', async () => {
    const f = await fixture(); ok(await action(f, 'problem', { pickedQty: 7 })); const sheet = await view(f);
    const [review, picked] = await Promise.all([
      check(f, sheet.reports[0]._id, { checked: true, expectedReportsVersion: sheet.reportsVersion }),
      api(f.path + '/problem', { actor: worker, method: 'POST', body: { allocationId: String(f.allocation._id), expectedRevision: sheet.version, pickedQty: 8 } }),
    ]);
    ok(picked); assert.ok([200, 409].includes(review.status));
    const latest = await view(f); assert.equal(latest.items[0].pickedQty, 8); assert.equal(latest.reports.length, 2);
    assert.equal(latest.stockChecksPending, review.status === 200 ? 1 : 2);
    assert.equal(Boolean(latest.reports[0].checkedAt), review.status === 200); assert.equal(latest.reports[1].checkedAt, undefined);
  });
});
