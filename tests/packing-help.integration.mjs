// Explicit disposable local DB; notification delivery is injected, never real.
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import express from 'express';
import cookieParser from 'cookie-parser';
import User from '../models/userModel.js';
import Order from '../models/orderModel.js';
import Product from '../models/productModel.js';
import Slot from '../models/slotModel.js';
import SlotItem from '../models/slotItemModel.js';
import OrderAllocation from '../models/orderAllocationModel.js';
import InventoryMovement from '../models/inventoryMovementModel.js';
import packingRoutes from '../routes/packingRoutes.js';
import orderRoutes from '../routes/orderRoutes.js';
import { errorHandler } from '../middleware/errorMiddleware.js';
import { testSessionCookies } from './helpers/sessionCookie.mjs';
import { dispatchPackingHelpNotifications } from '../utils/packingHelpNotifications.js';

const uri = process.env.PACKING_HELP_TEST_URI;
test('worker help requests and durable Telegram delivery', { skip: !uri, timeout: 120000 }, async t => {
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\/megadie_packing_help_test(?:\?|$)/);
  process.env.JWT_SECRET = 'isolated-packing-help-test'; process.env.NODE_ENV = 'test';
  await mongoose.connect(uri, { autoIndex: false }); await mongoose.connection.dropDatabase();
  t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  await OrderAllocation.createIndexes(); await InventoryMovement.createCollection();
  const makeUser = (name, values = {}) => User.create({ name, email: name + '@test.invalid', phoneNumber: name, password: 'test-password', approvalStatus: 'Approved', ...values });
  const admin = await makeUser('Owner', { isAdmin: true }), worker = await makeUser('Worker', { isWorker: true }), other = await makeUser('Other', { isWorker: true }), client = await makeUser('Client');
  const app = express(); app.use(express.json(), cookieParser()); app.use('/api/packing', packingRoutes); app.use('/api/orders', orderRoutes); app.use(errorHandler);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port + '/api', cookieFor = testSessionCookies();
  async function api(path, { actor = worker, method = 'GET', body, origin = 'http://localhost:5173' } = {}) {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: await cookieFor(actor) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function fixture({ targetQty = 0, ordered = 37 } = {}) {
    // Keep dispatch focused on this scenario; all records are in the guarded DB.
    await Order.deleteMany({}); await OrderAllocation.deleteMany({});
    const product = new mongoose.Types.ObjectId(), second = new mongoose.Types.ObjectId();
    await Product.collection.insertMany([{ _id: product, name: 'Red ribbon', sku: 'RIB_RED_[25]', packingUnit: '100yd Roll', isActive: true, cbm: 1 }, { _id: second, name: 'Blue ribbon', sku: 'BLUE', packingUnit: 'Pack', isActive: true, cbm: 1 }]);
    const slots = await Slot.create(['A', 'B', 'C'].map(unit => ({ store: 'AE1', unit, position: 1, cbm: 1000 })));
    await SlotItem.collection.insertMany([{ product, slot: slots[0]._id, qty: ordered, cbm: ordered }, { product, slot: slots[1]._id, qty: targetQty, cbm: targetQty }, { product: second, slot: slots[2]._id, qty: 10, cbm: 10 }]);
    const order = await Order.create({ user: client._id, status: 'Shipping', packingSentAt: new Date(), packingWorker: worker._id, assignedTo: worker.name, preparationMode: 'prepare_only', orderItems: [{ product, sku: 'RIB_RED_[25]', qty: ordered, unitPrice: 2.5 }, { product: second, sku: 'BLUE', qty: 2, unitPrice: 3 }], allocationStatus: 'Allocated' });
    const allocation = await OrderAllocation.create({ order: order._id, product, slot: slots[0]._id, qty: ordered, by: admin._id });
    await OrderAllocation.create({ order: order._id, product: second, slot: slots[2]._id, qty: 2, by: admin._id });
    return { order, product, second, slots, allocation, path: '/packing/orders/' + order._id };
  }
  const ok = result => assert.equal(result.status, 200, JSON.stringify(result.body));
  const view = async f => { const result = await api(f.path); ok(result); return result.body.data; };
  const saved = f => Order.findById(f.order._id).select('+packingHelp +packingReports +reservationRevision');
  async function action(f, action, values = {}, options = {}) {
    return api(f.path + '/' + action, { method: 'POST', body: { expectedRevision: (await view(f)).version, allocationId: String(f.allocation._id), ...values }, ...options });
  }
  async function edit(f, items) {
    const editor = await api('/orders/' + f.order._id + '/items-editor', { actor: admin }); ok(editor);
    const body = { expectedRevision: editor.body.data.version, items };
    const plan = await api('/orders/' + f.order._id + '/items-preview', { actor: admin, method: 'POST', body }); ok(plan);
    const result = await api('/orders/' + f.order._id + '/items', { actor: admin, method: 'PUT', body: { ...body, token: plan.body.data.token, confirmedPhysicalReturn: true, cancelOrder: items.length === 0 } }); ok(result);
    return view(f);
  }

  await t.test('37 required, seven picked: automatic help is saved once and the alert has actionable details', async () => {
    const f = await fixture();
    const report = await action(f, 'problem', { pickedQty: 7, note: 'Only seven physically collected; carton is empty.' }); ok(report);
    assert.equal(report.body.data.helpRequestedItems, 1);
    assert.ok(report.body.data.items[0].helpRequestedAt);
    assert.equal(report.body.data.items[0].pickedQty, 7);
    assert.equal(report.body.data.items[0].allocations[0].problemQty, 30);
    const initial = await saved(f), requestId = String(initial.packingHelp[0]._id);
    assert.equal(initial.packingHelp.length, 1); assert.equal(initial.packingHelp[0].reason, 'no_alternative');
    ok(await action(f, 'problem', { pickedQty: 7, note: 'Still short.' })); ok(await action(f, 'help')); ok(await action(f, 'help'));
    assert.equal((await saved(f)).packingHelp.length, 1);
    const board = await api('/packing/orders?view=board'); ok(board); assert.equal(board.body.groups.to_pack.data[0].helpRequestedItems, 1);
    assert.doesNotMatch(JSON.stringify(report.body.data), /unitPrice|totalPrice|notification|requestedBy|packingHelp|itemChanges/);
    const messages = []; const send = async message => { messages.push(message); return true; };
    await dispatchPackingHelpNotifications({ send }); await dispatchPackingHelpNotifications({ send });
    assert.equal(messages.length, 1); assert.match(messages[0], /Ordered: 37 · Picked: 7 · Remaining: 30/); assert.match(messages[0], /Reported missing: 30/);
    assert.match(messages[0], /Client: Client/); assert.match(messages[0], /Product: RIB_RED_\[25\]/); assert.match(messages[0], /A1-AE1: 7 picked of 37; 30 missing/); assert.match(messages[0], /Still short/);
    assert.match(messages[0], new RegExp('/admin/orders/' + f.order._id + '/packing'));
    const sent = await saved(f); assert.equal(String(sent.packingHelp[0]._id), requestId); assert.ok(sent.packingHelp[0].notification.sentAt);
    assert.equal((await OrderAllocation.findById(f.allocation._id)).pickedQty, 7);
  });

  await t.test('alternatives keep the worker moving; explicit help remains available and duplicate taps cannot duplicate requests', async () => {
    const f = await fixture({ targetQty: 40 });
    const report = await action(f, 'problem', { pickedQty: 7 }); ok(report); assert.equal(report.body.data.helpRequestedItems, 0);
    assert.equal((await saved(f)).packingHelp.length, 0);
    const revision = (await view(f)).version;
    const results = await Promise.all([1, 2].map(() => api(f.path + '/help', { method: 'POST', body: { allocationId: String(f.allocation._id), expectedRevision: revision } })));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    const order = await saved(f); assert.equal(order.packingHelp.length, 1); assert.equal(order.packingHelp[0].reason, 'worker_requested');
    const replace = await action(f, 'replace', { slotId: String(f.slots[1]._id), qty: 30 }); ok(replace);
    assert.equal(replace.body.data.helpRequestedItems, 0); assert.equal(replace.body.data.items[0].helpRequestedAt, null);
    assert.equal(replace.body.data.items[0].allocations.find(row => row.slotId === String(f.slots[1]._id)).pickedQty, 0);
    assert.ok((await saved(f)).packingHelp[0].resolvedAt);
    let sends = 0; await dispatchPackingHelpNotifications({ send: async () => { sends++; return true; } }); assert.equal(sends, 0);
  });

  await t.test('a reported-short slot rejects the completion shortcut, while explicit totals can resolve a genuine recovery', async () => {
    const f = await fixture();
    ok(await action(f, 'problem', { pickedQty: 7 }));
    const initial = await saved(f);
    assert.equal((await view(f)).items[0].allocations[0].canPick, false);
    for (const actor of [worker, admin]) {
      const rejected = await action(f, 'pick', { pickedQty: 37, confirmedReturn: true }, { actor });
      assert.equal(rejected.status, 409); assert.match(rejected.body.message, /actual picked total/);
      assert.equal((await OrderAllocation.findById(f.allocation._id)).pickedQty, 7);
      assert.equal((await saved(f)).reservationRevision, initial.reservationRevision);
      assert.equal((await view(f)).helpRequestedItems, 1);
    }
    const healthy = (await view(f)).items[1].allocations[0]; assert.equal(healthy.canPick, true);
    ok(await action(f, 'pick', { allocationId: healthy.allocationId, pickedQty: 2 }));
    assert.equal((await view(f)).helpRequestedItems, 1);
    const partial = await action(f, 'problem', { pickedQty: 12 }); ok(partial);
    assert.equal(partial.body.data.items[0].allocations[0].problemQty, 25); assert.equal(partial.body.data.helpRequestedItems, 1);
    const recovered = await action(f, 'problem', { pickedQty: 37 }); ok(recovered);
    assert.equal(recovered.body.data.helpRequestedItems, 0); assert.equal(recovered.body.data.canPack, true);
    const order = await saved(f); assert.ok(order.packingHelp[0].resolvedAt); assert.equal(order.packingReports.length, 2);
    assert.equal((await SlotItem.findOne({ product: f.product, slot: f.slots[0]._id })).qty, 37);
  });

  await t.test('partial replacement automatically requests help for the remaining shortage', async () => {
    const f = await fixture({ targetQty: 5 }); ok(await action(f, 'problem', { pickedQty: 7 }));
    assert.equal((await saved(f)).packingHelp.length, 0);
    const result = await action(f, 'replace', { slotId: String(f.slots[1]._id), qty: 5 }); ok(result);
    assert.equal(result.body.data.helpRequestedItems, 1); assert.equal(result.body.data.items[0].allocations[0].problemQty, 25);
    const messages = []; await dispatchPackingHelpNotifications({ send: async message => { messages.push(message); return true; } });
    assert.match(messages[0], /Reported missing: 25/); assert.match(messages[0], /Remaining: 30/);
  });

  await t.test('several bad slots for the same product create one help request and one combined alert', async () => {
    const f = await fixture({ targetQty: 20, ordered: 37 });
    await OrderAllocation.updateOne({ _id: f.allocation._id }, { qty: 17 });
    const second = await OrderAllocation.create({ order: f.order._id, product: f.product, slot: f.slots[1]._id, qty: 20, by: admin._id });
    ok(await action(f, 'problem', { pickedQty: 7 }));
    ok(await action(f, 'problem', { allocationId: String(second._id), pickedQty: 2 }));
    assert.equal((await saved(f)).packingHelp.length, 1);
    const messages = []; await dispatchPackingHelpNotifications({ send: async message => { messages.push(message); return true; } });
    assert.equal(messages.length, 1); assert.match(messages[0], /A1-AE1: 7 picked of 17; 10 missing/); assert.match(messages[0], /B1-AE1: 2 picked of 20; 18 missing/);
    assert.match(messages[0], /Picked: 9/); assert.match(messages[0], /Reported missing: 28/);
  });

  await t.test('unrelated admin edits preserve help; accepting the picked quantity resolves it without a worker acknowledgement', async () => {
    const f = await fixture(); ok(await action(f, 'problem', { pickedQty: 7 }));
    let result = await edit(f, [{ key: 'line-0', qty: 37 }, { key: 'line-1', qty: 1 }]);
    assert.equal(result.helpRequestedItems, 1); assert.equal(result.items[0].helpRequestedAt !== null, true);
    result = await edit(f, [{ key: 'line-0', qty: 7 }, { key: 'line-1', qty: 1 }]);
    assert.equal(result.helpRequestedItems, 0); assert.equal(result.items[0].pickedQty, 7);
    assert.deepEqual(result.itemsChanges, [{ productId: String(f.product), sku: 'RIB_RED_[25]', fromQty: 37, toQty: 7, unit: '100yd Roll' }]);
    assert.ok((await saved(f)).packingHelp[0].resolvedAt); assert.equal((await saved(f)).packingReports.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /unitPrice|totalPrice|before|after|notification/);
    assert.equal((await SlotItem.findOne({ product: f.product, slot: f.slots[0]._id })).qty, 37);
  });

  await t.test('removing a short item clears help, retains the original report and explains the removal to workers', async () => {
    const f = await fixture(); ok(await action(f, 'problem', { pickedQty: 7 }));
    const result = await edit(f, [{ key: 'line-1', qty: 2 }]);
    assert.equal(result.helpRequestedItems, 0); assert.equal(result.items.length, 1); assert.equal(result.itemsChanges[0].toQty, 0);
    const order = await saved(f); assert.ok(order.packingHelp[0].resolvedAt); assert.equal(order.packingReports.length, 1);
  });

  await t.test('notification failure preserves picks and help, retries later, and never changes the order revision', async () => {
    const f = await fixture(); ok(await action(f, 'problem', { pickedQty: 7 })); const initial = await saved(f);
    const now = new Date(Date.now() + 1000); let attempts = 0;
    await dispatchPackingHelpNotifications({ now, send: async () => { attempts++; throw new Error('simulated network failure'); } });
    let order = await saved(f); assert.equal(order.packingHelp.length, 1); assert.equal(order.reservationRevision, initial.reservationRevision);
    assert.equal(order.packingHelp[0].notification.attempts, 1); assert.equal(order.packingHelp[0].resolvedAt, undefined); assert.equal(order.packingHelp[0].notification.sentAt, undefined);
    await dispatchPackingHelpNotifications({ now: new Date(now.getTime() + 1000), send: async () => { attempts++; return true; } }); assert.equal(attempts, 1);
    await dispatchPackingHelpNotifications({ now: new Date(now.getTime() + 31000), send: async () => { attempts++; return true; } });
    order = await saved(f); assert.equal(attempts, 2); assert.ok(order.packingHelp[0].notification.sentAt); assert.equal(order.reservationRevision, initial.reservationRevision);
    assert.equal((await OrderAllocation.findById(f.allocation._id)).pickedQty, 7);
  });

  await t.test('concurrent delivery workers claim once; an expired claim is recovered after a restart', async () => {
    const f = await fixture(); ok(await action(f, 'problem', { pickedQty: 7 }));
    let sends = 0; const send = async () => { sends++; await new Promise(resolve => setTimeout(resolve, 30)); return true; };
    await Promise.all([dispatchPackingHelpNotifications({ send }), dispatchPackingHelpNotifications({ send })]); assert.equal(sends, 1);
    const order = await saved(f), request = order.packingHelp[0], now = new Date();
    await Order.updateOne({ _id: order._id }, { $unset: { 'packingHelp.0.notification.sentAt': '' }, $set: { 'packingHelp.0.notification.claim': 'crashed-process', 'packingHelp.0.notification.leaseUntil': new Date(now.getTime() - 1000), 'packingHelp.0.notification.nextAttemptAt': now } });
    await dispatchPackingHelpNotifications({ now, send }); assert.equal(sends, 2);
    assert.ok((await saved(f)).packingHelp.find(item => String(item._id) === String(request._id)).notification.sentAt);
  });

  await t.test('failed pending delivery is discarded when the admin resolves the shortage', async () => {
    const f = await fixture(); ok(await action(f, 'problem', { pickedQty: 7 }));
    await dispatchPackingHelpNotifications({ send: async () => false });
    await edit(f, [{ key: 'line-0', qty: 7 }, { key: 'line-1', qty: 2 }]);
    let sends = 0; await dispatchPackingHelpNotifications({ now: new Date(Date.now() + 3600000), send: async () => { sends++; return true; } }); assert.equal(sends, 0);
  });

  await t.test('a fresh shortage after resolution creates a new episode; old reports do not keep resolved help active', async () => {
    const f = await fixture({ targetQty: 40 }); ok(await action(f, 'problem', { pickedQty: 7 })); ok(await action(f, 'help'));
    const replaced = await action(f, 'replace', { slotId: String(f.slots[1]._id), qty: 30 }); ok(replaced);
    const target = replaced.body.data.items[0].allocations.find(row => row.slotId === String(f.slots[1]._id));
    ok(await action(f, 'problem', { allocationId: target.allocationId, pickedQty: 2 }));
    const order = await saved(f); assert.equal(order.packingHelp.length, 2); assert.ok(order.packingHelp[0].resolvedAt); assert.equal(order.packingHelp[1].resolvedAt, undefined);
    assert.equal((await view(f)).helpRequestedItems, 1);
  });

  await t.test('help requires assigned-worker access, a saved shortage, the latest version and trusted website origin', async () => {
    const f = await fixture(); assert.equal((await action(f, 'help')).status, 409);
    ok(await action(f, 'problem', { pickedQty: 7 }));
    for (const actor of [other, client, admin]) {
      const result = await api(f.path + '/help', { actor, method: 'POST', body: { expectedRevision: (await view(f)).version, allocationId: String(f.allocation._id) } }); assert.equal(result.status, 403);
    }
    assert.equal((await action(f, 'help', {}, { origin: 'https://untrusted.test' })).status, 403);
    assert.equal((await api(f.path + '/help', { method: 'POST', body: { expectedRevision: 0, allocationId: String(f.allocation._id) } })).status, 409);
    assert.equal((await saved(f)).packingHelp.length, 1);
  });
});
