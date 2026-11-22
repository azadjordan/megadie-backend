// Explicit disposable local replica set only. Never imports server.js or loads .env.
import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import express from "express";
import cookieParser from "cookie-parser";
import User from "../models/userModel.js";
import Order from "../models/orderModel.js";
import Product from "../models/productModel.js";
import Slot from "../models/slotModel.js";
import SlotItem from "../models/slotItemModel.js";
import OrderAllocation from "../models/orderAllocationModel.js";
import InventoryMovement from "../models/inventoryMovementModel.js";
import Quote from "../models/quoteModel.js";
import Invoice from "../models/invoiceModel.js";
import Payment from "../models/paymentModel.js";
import packingRoutes from "../routes/packingRoutes.js";
import orderRoutes from "../routes/orderRoutes.js";
import userRoutes from "../routes/userRoutes.js";
import productRoutes from "../routes/productRoutes.js";
import slotItemRoutes from "../routes/slotItemRoutes.js";
import slotRoutes from "../routes/slotRoutes.js";
import { errorHandler } from "../middleware/errorMiddleware.js";
import { assignDeliveryWorker, deliveryWorkerChoices } from '../utils/workerDelivery.js';
import { testSessionCookies } from "./helpers/sessionCookie.mjs";

const uri = process.env.WORKER_DELIVERY_TEST_URI;
test("worker delivery assignments with an isolated replica set", { skip: !uri, timeout: 120000 }, async t => {
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\/megadie_worker_delivery_test(?:\?|$)/);
  process.env.JWT_SECRET = "local-packing-tests-only";
  process.env.NODE_ENV = "production";
  await mongoose.connect(uri, { autoIndex: false });
  await mongoose.connection.dropDatabase();
  t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  await OrderAllocation.createIndexes();
  await InventoryMovement.createCollection();
  const makeUser = (name, values = {}) => User.create({ name, email: `${name}@test.invalid`, phoneNumber: name, password: "test-password", approvalStatus: "Approved", ...values });
  const admin = await makeUser("Admin", { isAdmin: true });
  const worker = await makeUser("Worker", { isWorker: true });
  const other = await makeUser("Other", { isWorker: true });
  const customer = await makeUser("Client");
  const app = express(); app.use(express.json(), cookieParser());
  app.use("/api/packing", packingRoutes); app.use("/api/orders", orderRoutes); app.use("/api/users", userRoutes);
  app.use("/api/products", productRoutes); app.use("/api/slot-items", slotItemRoutes); app.use("/api/slots", slotRoutes); app.use(errorHandler);
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const cookieFor = testSessionCookies();
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function api(path, { actor = admin, method = "GET", body, cookie } = {}) {
    const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Origin: "http://localhost:5173", Cookie: cookie || await cookieFor(actor) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  const view = async (f, actor = admin) => (await api(`/packing/orders/${f.order._id}`, { actor })).body.data;
  async function send(f, actor = worker) {
    const v = await view(f);
    return api(`/packing/orders/${f.order._id}/send`, { method: "POST", body: { workerId: String(actor._id), preparationMode: "prepare_only", deliveryDetails: {}, expectedRevision: v.version, expectedDeliveryRevision: v.deliveryRevision } });
  }
  async function action(f, name, body = {}, actor = worker) {
    const v = await view(f, actor);
    assert.ok(v, "Task must be readable before the test action");
    return api(`/packing/orders/${f.order._id}/${name}`, { actor, method: "POST", body: { expectedRevision: v.version, ...body } });
  }
  async function fixture({ targetQty = 10 } = {}) {
    const productId = new mongoose.Types.ObjectId();
    await Product.collection.insertOne({ _id: productId, name: "Ribbon", sku: `RIB-${productId}`, packingUnit: "100yd Roll", cbm: 1 });
    const slots = await Slot.create([1, 2, 3].map((position, index) => ({ store: "AE1", unit: ["A", "B", "C"][index], position, cbm: 1000, occupiedCbm: 100 })));
    await SlotItem.collection.insertMany(slots.map((slot, index) => ({ product: productId, slot: slot._id, qty: index ? targetQty : 20, cbm: index ? targetQty : 20 })));
    const order = await Order.create({ user: customer._id, status: "Shipping", orderItems: [{ product: productId, sku: `RIB-${productId}`, qty: 10, unitPrice: 12 }], allocationStatus: "Allocated", totalPrice: 120 });
    const allocation = await OrderAllocation.create({ order: order._id, product: productId, slot: slots[0]._id, qty: 10, by: admin._id });
    return { order, productId, slots, allocation, allocationId: String(allocation._id) };
  }
  const expectOK = result => assert.equal(result.status, 200, JSON.stringify(result.body));

  await User.updateOne({ _id: customer._id }, { $set: { address: 'Order destination', deliveryContactName: 'Recipient', deliveryPhoneNumber: '+971501234567' } });
  const task = async (f, actor = worker) => (await api(`/packing/deliveries/${f.order._id}`, { actor })).body.data;
  const assign = async (f, driver = other, actor = admin, options = {}) => api(`/packing/deliveries/${f.order._id}/assignment`, { actor, method: 'POST', body: { workerId: driver ? String(driver._id) : null, expectedRevision: (await task(f, actor))?.version, ...options } });
  const move = async (f, name, actor = other, options = {}) => api(`/packing/deliveries/${f.order._id}/movement`, { actor, method: 'POST', body: { action: name, expectedRevision: (await task(f, actor))?.version, confirmedReady: true, confirmedReceived: true, confirmedReturn: true, ...options } });
  async function packed({ driver = null, mode = 'prepare_only' } = {}) {
    const f = await fixture();
    const v = await view(f);
    expectOK(await api(`/packing/orders/${f.order._id}/send`, { method: 'POST', body: { workerId: String(worker._id), preparationMode: mode, deliveryDetails: { address: 'Saved order location', contactName: 'Order recipient', phoneNumber: '+971501111111' }, expectedRevision: v.version, expectedDeliveryRevision: v.deliveryRevision } }));
    expectOK(await action(f, 'pick', { allocationId: f.allocationId, pickedQty: 10 }));
    expectOK(await action(f, 'packed'));
    if (driver) expectOK(await assign(f, driver));
    return f;
  }

  await t.test('legacy tasks inherit the packer only for prepare and deliver; explicit unassignment stays unassigned', async () => {
    const f = await fixture();
    await Order.updateOne({ _id: f.order._id }, { $set: { packingWorker: worker._id, packingSentAt: new Date(), preparationMode: 'prepare_deliver' } });
    assert.equal((await task(f)).worker.id, String(worker._id));
    let list = await api('/packing/deliveries', { actor: worker }); expectOK(list); assert.ok(list.body.data.some(row => row.orderId === String(f.order._id)));
    await Order.updateOne({ _id: f.order._id }, { $set: { deliveryWorker: null } });
    assert.equal((await task(f)).worker, null);
    list = await api('/packing/deliveries', { actor: worker }); assert.ok(!list.body.data.some(row => row.orderId === String(f.order._id)));
  });

  await t.test('initial pack and deliver defaults to the same worker and blocks receipt before departure', async () => {
    const f = await packed({ mode: 'prepare_deliver' });
    const d = await task(f); assert.equal(d.worker.id, String(worker._id)); assert.equal(d.canDepart, true); assert.equal(d.canDeliver, false);
    assert.equal((await assign(f, null, worker)).status, 403);
    assert.equal((await move(f, 'delivered', worker)).status, 409);
    expectOK(await move(f, 'departed', worker));
    expectOK(await move(f, 'delivered', worker));
    const saved = await Order.findById(f.order._id).select('+deliveryHistory');
    assert.equal(saved.status, 'Delivered'); assert.equal(saved.deliveredBy, worker.name);
    assert.equal(String(saved.deliveryHistory.at(-1).worker), String(worker._id));
    const list = await api('/packing/deliveries', { actor: worker }); assert.ok(!list.body.data.some(row => row.orderId === String(f.order._id)));
    assert.equal((await task(f)).deliveryState, 'delivered');
  });

  await t.test('admin and assigned-worker receipt delete the quote without changing unpaid, partial or paid billing and stock', async () => {
    for (const actor of [other, admin]) for (const paidAmount of [0, 3000, 12000]) {
      const f = await packed({ driver: other });
      const quote = await Quote.create({ user: customer._id, order: f.order._id, status: 'Confirmed', requestedItems: [{ product: f.productId, qty: 10, unitPrice: 12 }] });
      const invoice = await Invoice.create({ user: customer._id, order: f.order._id, amountMinor: 12000, dueDate: new Date('2030-01-01'), currency: 'AED', minorUnitFactor: 100 });
      if (paidAmount) await Payment.create({ invoice: invoice._id, amountMinor: paidAmount, paymentMethod: 'Cash', receivedBy: 'Company Account' });
      await Order.updateOne({ _id: f.order._id }, { $set: { quote: quote._id, invoice: invoice._id } });
      const billBefore = await Invoice.findById(invoice._id).lean();
      const paymentsBefore = await Payment.find({ invoice: invoice._id }).lean();
      const stockBefore = await SlotItem.find({ product: f.productId }).lean();
      const allocationsBefore = await OrderAllocation.find({ order: f.order._id }).lean();
      expectOK(await move(f, 'departed'));
      assert.ok(await Quote.exists({ _id: quote._id }), 'Departure must retain the quote');
      assert.equal((await Order.findById(f.order._id)).status, 'Shipping');
      assert.equal((await move(f, 'delivered', worker)).status, 403, 'Packing responsibility alone cannot confirm receipt');
      assert.equal((await move(f, 'delivered', actor, { confirmedReceived: false })).status, 400);
      assert.ok(await Quote.exists({ _id: quote._id }), 'Rejected receipt must retain the quote');
      expectOK(await move(f, 'delivered', actor));
      const saved = await Order.findById(f.order._id).select('+deliveryHistory');
      assert.equal(saved.status, 'Delivered'); assert.equal(saved.quote, null);
      assert.equal(await Quote.exists({ _id: quote._id }), null);
      assert.equal(saved.deliveredBy, other.name); assert.ok(saved.deliveredAt);
      assert.equal(String(saved.deliveryHistory.at(-1).actor), String(actor._id));
      assert.equal(String(saved.deliveryHistory.at(-1).worker), String(other._id));
      assert.equal(saved.deliveryHistory.filter(event => event.action === 'delivered').length, 1);
      assert.equal(saved.stockFinalizedAt, undefined);
      assert.deepEqual(await Invoice.findById(invoice._id).lean(), billBefore);
      assert.deepEqual(await Payment.find({ invoice: invoice._id }).lean(), paymentsBefore);
      assert.deepEqual(await SlotItem.find({ product: f.productId }).lean(), stockBefore);
      assert.deepEqual(await OrderAllocation.find({ order: f.order._id }).lean(), allocationsBefore);
      assert.equal((await move(f, 'delivered', actor)).status, 409);
      assert.equal((await Order.findById(f.order._id).select('+deliveryHistory')).deliveryHistory.filter(event => event.action === 'delivered').length, 1);
    }
  });

  await t.test('a failed quote deletion rolls back receipt and history so the assigned worker can retry safely', async () => {
    const f = await packed({ driver: other });
    const quote = await Quote.create({ user: customer._id, order: f.order._id, status: 'Confirmed', requestedItems: [{ product: f.productId, qty: 10, unitPrice: 12 }] });
    await Order.updateOne({ _id: f.order._id }, { $set: { quote: quote._id } });
    expectOK(await move(f, 'departed'));
    const before = await Order.findById(f.order._id).select('+reservationRevision +deliveryHistory').lean();
    const originalDelete = Quote.deleteOne;
    try {
      Quote.deleteOne = () => { throw new Error('Simulated quote deletion failure'); };
      assert.equal((await move(f, 'delivered')).status, 500);
    } finally { Quote.deleteOne = originalDelete; }
    assert.deepEqual(await Order.findById(f.order._id).select('+reservationRevision +deliveryHistory').lean(), before);
    assert.ok(await Quote.exists({ _id: quote._id }));
    expectOK(await move(f, 'delivered'));
    assert.equal((await Order.findById(f.order._id)).status, 'Delivered');
    assert.equal(await Quote.exists({ _id: quote._id }), null);
  });

  await t.test('only admins may select, assign, reassign or remove delivery workers; rejected writes preserve all records', async () => {
    const f = await packed({ driver: other });
    const before = await Order.findById(f.order._id).select('+reservationRevision +deliveryHistory').lean();
    const allocations = await OrderAllocation.find({ order: f.order._id }).lean();
    const stock = await SlotItem.find({ product: f.productId }).lean();
    for (const actor of [worker, other]) {
      assert.equal((await task(f, actor)).canAssign, false);
      assert.equal((await api(`/packing/deliveries/${f.order._id}/workers`, { actor })).status, 403);
      for (const target of [worker, other, null]) assert.equal((await assign(f, target, actor)).status, 403);
      await assert.rejects(assignDeliveryWorker({ orderId: String(f.order._id), actor, workerId: String(worker._id), expectedRevision: before.reservationRevision }), error => error.statusCode === 403);
      await assert.rejects(deliveryWorkerChoices(String(f.order._id), actor), error => error.statusCode === 403);
    }
    // A stale admin flag cannot bypass the service's current role check.
    await assert.rejects(assignDeliveryWorker({ orderId: String(f.order._id), actor: { _id: worker._id, isAdmin: true }, workerId: String(other._id), expectedRevision: before.reservationRevision }), error => error.statusCode === 403);
    assert.deepEqual(await Order.findById(f.order._id).select('+reservationRevision +deliveryHistory').lean(), before);
    assert.deepEqual(await OrderAllocation.find({ order: f.order._id }).lean(), allocations);
    assert.deepEqual(await SlotItem.find({ product: f.productId }).lean(), stock);
    assert.equal((await task(f, admin)).canAssign, true);
    expectOK(await api(`/packing/deliveries/${f.order._id}/workers`));
    expectOK(await assign(f, worker));
    expectOK(await assign(f, null));
    const waiting = await task(f, worker); assert.equal(waiting.worker, null); assert.equal(waiting.canAssign, false); assert.equal(waiting.scope, 'recent-work'); assert.equal(waiting.readyReason, '');
    expectOK(await assign(f, other));
    expectOK(await move(f, 'departed')); expectOK(await move(f, 'delivered'));
  });

  await t.test('delivery assignment after packing and invoicing preserves stock and permits only a scoped delivery view', async () => {
    const f = await packed();
    await Order.updateOne({ _id: f.order._id }, { $set: { invoice: new mongoose.Types.ObjectId() } });
    const before = await Order.findById(f.order._id).lean(), allocations = await OrderAllocation.find({ order: f.order._id }).lean(), stock = await SlotItem.find({ product: f.productId }).lean();
    expectOK(await assign(f));
    const d = await task(f, other); assert.equal(d.delivery.address, 'Saved order location'); assert.equal(d.canDepart, true); assert.equal(d.items[0].qty, 10);
    for (const key of ['invoice', 'totalPrice', 'adminToAdminNote', 'packingActivity', 'packingReports', 'deliveryHistory', 'allocations']) assert.equal(d[key], undefined);
    assert.equal((await api(`/packing/orders/${f.order._id}`, { actor: other })).status, 403);
    const p = await task(f, worker); assert.equal(p.delivery, null); assert.equal(p.scope, 'recent-work'); assert.equal(p.items[0].qty, 10); assert.ok(p.items.every(item => !item.allocations.length && !item.alternatives.length)); assert.equal(p.canDepart, false); assert.equal(p.canAssign, false);
    assert.equal((await view(f, worker)).delivery, null);
    const after = await Order.findById(f.order._id).lean();
    for (const key of ['packedAt', 'packedBy', 'packingWorker', 'invoice', 'orderItems']) assert.deepEqual(after[key], before[key]);
    assert.deepEqual(await OrderAllocation.find({ order: f.order._id }).lean(), allocations); assert.deepEqual(await SlotItem.find({ product: f.productId }).lean(), stock);
    expectOK(await move(f, 'departed')); expectOK(await move(f, 'delivered'));
    assert.equal((await Order.findById(f.order._id)).stockFinalizedAt, undefined);
  });

  await t.test('waiting orders cannot depart; only the current driver may act and former drivers lose destination access', async () => {
    const f = await fixture(); expectOK(await send(f)); expectOK(await assign(f));
    assert.equal((await task(f, other)).deliveryState, 'waiting'); assert.equal((await move(f, 'departed')).status, 409);
    assert.equal((await api(`/packing/deliveries/${f.order._id}`, { actor: customer })).status, 403);
    assert.equal((await move(f, 'reshelved')).status, 403);
    expectOK(await assign(f, worker, admin));
    assert.equal((await api(`/packing/deliveries/${f.order._id}`, { actor: other })).status, 403);
    assert.equal((await api(`/packing/deliveries/${f.order._id}/workers`, { actor: other })).status, 403);
    assert.equal((await api(`/packing/deliveries/${f.order._id}/movement`, { actor: other, method: 'POST', body: { action: 'departed', expectedRevision: (await task(f)).version } })).status, 403);
  });

  await t.test('worker payload cannot change financial details; repeated and stale actions cannot commit', async () => {
    const f = await packed({ driver: other }), version = (await task(f, other)).version;
    assert.equal((await move(f, 'departed', other, { extraFee: 100 })).status, 400);
    assert.equal((await task(f, other)).version, version);
    expectOK(await move(f, 'departed'));
    assert.equal((await move(f, 'departed', other, { expectedRevision: version })).status, 409);
    assert.equal((await move(f, 'returned', other, { confirmedReturn: false })).status, 400);
    assert.equal((await assign(f, worker, other)).status, 403);
    assert.equal((await assign(f, worker, admin)).status, 400);
    expectOK(await assign(f, worker, admin, { confirmedHandover: true }));
    assert.equal((await api(`/packing/deliveries/${f.order._id}`, { actor: other })).status, 403);
    expectOK(await move(f, 'returned', worker));
    const d = await task(f); assert.equal(d.deliveryState, 'returned'); assert.equal(d.canDepart, true);
    assert.ok((await Order.findById(f.order._id)).packedAt); assert.equal((await OrderAllocation.findById(f.allocationId)).pickedQty, 10);
    expectOK(await move(f, 'departed', worker)); expectOK(await move(f, 'delivered', worker));
  });

  await t.test('admin corrections retain event history and refuse finalized stock', async () => {
    const f = await packed({ driver: other }); expectOK(await move(f, 'departed')); expectOK(await move(f, 'delivered'));
    assert.equal((await move(f, 'corrected', other, { confirmedCorrection: true, note: 'Wrong tap' })).status, 403);
    assert.equal((await move(f, 'corrected', admin, { confirmedCorrection: true })).status, 400);
    expectOK(await move(f, 'corrected', admin, { confirmedCorrection: true, note: 'Customer receipt tapped by mistake' }));
    assert.equal((await task(f, other)).deliveryState, 'out');
    expectOK(await move(f, 'corrected', admin, { confirmedCorrection: true, note: 'Departure never happened; packed goods are still here' }));
    assert.equal((await task(f, other)).deliveryState, 'ready'); assert.equal((await OrderAllocation.findById(f.allocationId)).pickedQty, 10);
    expectOK(await move(f, 'departed')); expectOK(await move(f, 'delivered'));
    await Order.updateOne({ _id: f.order._id }, { $set: { stockFinalizedAt: new Date() } });
    assert.equal((await move(f, 'corrected', admin, { confirmedCorrection: true, note: 'Too late' })).status, 409);
    assert.equal((await Order.findById(f.order._id).select('+deliveryHistory')).deliveryHistory.filter(event => event.action === 'corrected').length, 2);
  });

  await t.test('assignment and departure racing on the same revision commit only once', async () => {
    const f = await packed({ driver: other }), version = (await task(f, other)).version;
    const results = await Promise.all([assign(f, worker, admin, { expectedRevision: version }), move(f, 'departed', other, { expectedRevision: version })]);
    assert.equal(results.filter(result => result.status === 200).length, 1);
    assert.ok(results.some(result => [403, 409].includes(result.status)));
    assert.equal((await OrderAllocation.findById(f.allocationId)).pickedQty, 10);
  });
  await t.test('an existing delivery assignment survives initial packing publication and later packing changes', async () => {
    const f = await fixture(); expectOK(await assign(f, other, admin));
    expectOK(await send(f));
    assert.equal((await task(f, other)).worker.id, String(other._id));
    const v = await view(f);
    expectOK(await api(`/packing/orders/${f.order._id}/send`, { method: 'POST', body: { workerId: String(worker._id), preparationMode: 'prepare_deliver', deliveryDetails: { address: 'Updated order address' }, expectedRevision: v.version, expectedDeliveryRevision: v.deliveryRevision } }));
    assert.equal((await task(f, other)).worker.id, String(other._id));
    assert.equal((await view(f, worker)).preparationMode, 'prepare_only');
  });
  await t.test('admin and worker departure paths require the same assigned-worker destination and rejected attempts change nothing', async () => {
    const f = await packed({ driver: other });
    await Order.updateOne({ _id: f.order._id }, { $set: { deliveryDetails: { address: '', googleMapsUrl: '' } } });
    const d = await task(f, admin);
    const general = (await api(`/orders/${f.order._id}/movement`)).body.data;
    assert.equal(d.canDepart, false);
    assert.equal(general.departureReadyReason, d.readyReason);
    assert.match(general.departureReadyReason, /location is missing/);
    const before = await Order.findById(f.order._id).select('+reservationRevision +deliveryHistory').lean();
    for (const actor of [admin, other]) assert.equal((await move(f, 'departed', actor)).status, 409);
    const rejected = await api(`/orders/${f.order._id}/movement`, { method: 'POST', body: { action: 'departed', expectedRevision: general.version, confirmedReady: true } });
    assert.equal(rejected.status, 409);
    const after = await Order.findById(f.order._id).select('+reservationRevision +deliveryHistory').lean();
    assert.equal(after.reservationRevision, before.reservationRevision);
    assert.deepEqual(after.deliveryHistory, before.deliveryHistory);
    assert.deepEqual(after.deliveryMovement, before.deliveryMovement);

    await Order.updateOne({ _id: f.order._id }, { $set: { deliveryDetails: { googleMapsUrl: 'https://maps.app.goo.gl/test-location' } } });
    const ready = (await api(`/orders/${f.order._id}/movement`)).body.data;
    assert.equal(ready.departureReadyReason, ''); assert.equal((await task(f, other)).canDepart, true);
    expectOK(await api(`/orders/${f.order._id}/movement`, { method: 'POST', body: { action: 'departed', expectedRevision: ready.version, confirmedReady: true } }));
    // A later location edit must not prevent recording an actual customer receipt.
    await Order.updateOne({ _id: f.order._id }, { $set: { deliveryDetails: { address: '' } } });
    assert.equal((await api(`/orders/${f.order._id}/movement`)).body.data.readyReason, '');
    expectOK(await move(f, 'delivered', other));
  });
  await t.test('admin preparation can use a delivery worker without a packing assignment and snapshots legacy destinations', async () => {
    const f = await fixture();
    await Order.updateOne({ _id: f.order._id }, { $set: { deliveryWorker: other._id }, $unset: { deliveryDetails: 1 } });
    const d = await task(f, admin);
    assert.equal(d.canDepart, true); assert.equal(d.manualPreparation, true);
    const general = (await api(`/orders/${f.order._id}/movement`)).body.data;
    assert.equal(general.departureReadyReason, '');
    expectOK(await api(`/orders/${f.order._id}/movement`, { method: 'POST', body: { action: 'departed', expectedRevision: general.version, confirmedReady: true } }));
    assert.equal((await Order.findById(f.order._id)).deliveryDetails.address, 'Order destination');
    expectOK(await move(f, 'delivered', other));
  });
  await t.test('worker assignment and a destination are optional for owner, courier and customer collection methods', async () => {
    for (const [method, handler] of [['company', 'Azad'], ['company', 'Momani'], ['courier', 'Courier A'], ['collection', '']]) {
      const f = await fixture();
      await Order.updateOne({ _id: f.order._id }, { $set: { deliveryDetails: { address: '' }, deliveryWorker: null } });
      const d = await task(f, admin);
      assert.equal(d.readyReason, ''); assert.equal(d.canDepart, false);
      const general = (await api(`/orders/${f.order._id}/movement`)).body.data;
      assert.equal(general.departureReadyReason, '');
      expectOK(await api(`/orders/${f.order._id}/movement`, { method: 'POST', body: { action: method === 'collection' ? 'collected' : 'departed', method, handler, expectedRevision: general.version, confirmedReady: true, confirmedReceived: true } }));
    }
  });
  await t.test('disabled targets, stale destination changes and a missing location cannot be bypassed', async () => {
    const f = await packed({ driver: other });
    const disabled = await makeUser('Disabled', { isWorker: false });
    assert.equal((await assign(f, disabled)).status, 409);
    const d = await task(f, other);
    await Order.updateOne({ _id: f.order._id }, { $set: { deliveryDetails: { address: '' } }, $inc: { reservationRevision: 1 } });
    assert.equal((await move(f, 'departed', other, { expectedRevision: d.version })).status, 409);
    assert.equal((await move(f, 'departed', other)).status, 409);
    const current = await task(f, other); assert.equal(current.canDepart, false); assert.match(current.readyReason, /location is missing/);
    await User.updateOne({ _id: other._id }, { $set: { isWorker: false } });
    assert.ok((await api(`/packing/deliveries/${f.order._id}`, { actor: other })).status >= 400);
    await User.updateOne({ _id: other._id }, { $set: { isWorker: true } });
  });
  await t.test('packing cards and shortcuts follow the explicit delivery assignment', async () => {
    const f = await packed({ mode: 'prepare_deliver', driver: other });
    const board = await api('/packing/orders?view=board', { actor: worker }); expectOK(board);
    const id = String(f.order._id);
    assert.ok(!board.body.groups.ready_handoff.data.some(row => row.orderId === id));
    assert.ok((await api('/packing/orders?view=board')).body.groups.ready_handoff.data.some(row => row.orderId === id));
    assert.ok(!board.body.groups.ready_delivery.data.some(row => row.orderId === id));
    const v = await view(f);
    expectOK(await api(`/packing/orders/${f.order._id}/send`, { method: 'POST', body: { workerId: String(worker._id), preparationMode: 'prepare_only', deliveryDetails: {}, expectedRevision: v.version, expectedDeliveryRevision: v.deliveryRevision } }));
    assert.equal(String((await Order.findById(f.order._id)).deliveryWorker), String(other._id));
  });

});
